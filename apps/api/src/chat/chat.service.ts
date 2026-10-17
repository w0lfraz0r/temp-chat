import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  credentialsSchema,
  type Envelope,
  type Participant,
} from '@temp-chat/protocol';
import { AppConfig } from '../config/app-config';
import {
  PresenceService,
  RECONCILE_MS,
  RENEW_MS,
  type Ownership,
} from '../presence/presence.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { RoomsService } from '../rooms/rooms.service';
import { RedisService } from '../redis/redis.service';
import { ClientAddressService } from '../common/client-address.service';
import { ApplicationState } from '../common/application-state.service';
import { ChatError } from './chat.error';
import { ChatTransport } from './chat.transport';
import type { ChatSocket } from './chat.types';

interface LocalConnection {
  socket: ChatSocket;
  deadline: number;
  redisGeneration: number;
}

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatService.name);
  private readonly replicaId = randomUUID();
  private readonly connections = new Map<string, LocalConnection>();
  private timer?: ReturnType<typeof setInterval>;
  private maintenance?: Promise<void>;
  private removeFailureListener?: () => void;
  private lastRenewal = 0;
  private active = 0;
  private readonly disconnects = new Set<Promise<void>>();

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(ChatTransport) private readonly transport: ChatTransport,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ClientAddressService)
    private readonly addresses: ClientAddressService,
    @Inject(ApplicationState) private readonly state: ApplicationState,
  ) {}

  get accepting() {
    return this.state.accepting && this.redis.ready;
  }

  private assertAccepting() {
    if (!this.accepting)
      throw new ServiceUnavailableException(
        'Service unavailable. Please reconnect and try again.',
      );
  }

  onModuleInit() {
    this.removeFailureListener = this.redis.onFailure(() => {
      for (const { socket } of this.connections.values())
        socket.disconnect(true);
    });
    this.timer = setInterval(() => {
      if (!this.maintenance) {
        this.maintenance = this.reconcile()
          .catch(() => {
            this.logger.error(
              'Presence maintenance failed; disconnecting local sessions.',
            );
            for (const { socket } of this.connections.values())
              socket.disconnect(true);
          })
          .finally(() => {
            this.maintenance = undefined;
          });
      }
    }, RECONCILE_MS).unref();
  }

  async authenticate(socket: ChatSocket) {
    this.assertAccepting();
    const started = performance.now();
    const redisGeneration = this.redis.generation;
    if (socket.handshake.headers.origin !== this.config.webOrigin)
      throw new ChatError('Origin not allowed.');
    await this.limits.take(
      `socket:${this.addresses.address(socket.request)}`,
      60,
      60_000,
    );
    const parsed = credentialsSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) throw new ChatError('Invalid session credentials.');
    const session = await this.rooms.authorize(
      parsed.data.roomId,
      parsed.data.token,
    );
    const remaining =
      Date.parse(session.expiresAt) -
      Date.parse(session.serverTime) -
      (performance.now() - started);
    if (remaining <= 0) throw new ChatError('Session invalid or room expired.');
    const claim = {
      roomId: session.roomId,
      participant: session.participant,
      socketId: socket.id,
      replicaId: this.replicaId,
      generation: randomUUID(),
    };
    const { previous, current } = await this.presence.attach(claim, remaining);
    socket.data.session = session;
    socket.data.ready = false;
    socket.data.ownership = current;
    this.connections.set(socket.id, {
      socket,
      deadline:
        started +
        Date.parse(session.expiresAt) -
        Date.parse(session.serverTime),
      redisGeneration,
    });
    this.assertAccepting();
    if (redisGeneration !== this.redis.generation)
      throw new ServiceUnavailableException('Shared coordination changed.');
    if (previous) this.transport.replace(previous.socketId);
  }

  async connect(socket: ChatSocket) {
    await this.ensureCurrent(socket);
    await this.publishPresence(socket.data.session.roomId);
  }

  disconnect(socket: ChatSocket) {
    this.connections.delete(socket.id);
    const work = this.release(socket);
    this.disconnects.add(work);
    return work.finally(() => this.disconnects.delete(work));
  }

  private async release(socket: ChatSocket) {
    if (!socket.data.ownership || !this.redis.ready) return;
    await this.presence.detach(socket.data.ownership);
    if (this.state.accepting)
      await this.publishPresence(socket.data.session.roomId);
  }

  async ready(socket: ChatSocket) {
    await this.ensureCurrent(socket);
    const { roomId, participant, token } = socket.data.session;
    await this.limits.take(`ready:${roomId}:${participant}`, 20, 60_000);
    const session = await this.rooms.authorize(roomId, token);
    if (!(await this.presence.markReady(socket.data.ownership)))
      throw new ChatError('Connection replaced.');
    await this.ensureCurrent(socket);
    socket.data.ready = true;
    return {
      ...session,
      peerOnline: Boolean((await this.peer(roomId, participant))?.ready),
    };
  }

  async takeMessageLimit(socket: ChatSocket) {
    await this.ensureCurrent(socket);
    const { roomId, participant } = socket.data.session;
    await this.limits.take(`message:${roomId}:${participant}`, 60, 60_000);
  }

  private peer(roomId: string, participant: Participant) {
    return this.presence.read(
      roomId,
      participant === 'creator' ? 'guest' : 'creator',
    );
  }

  async publishPresence(roomId: string) {
    const [creator, guest] = await Promise.all([
      this.presence.read(roomId, 'creator'),
      this.presence.read(roomId, 'guest'),
    ]);
    if (creator?.ready)
      this.transport.publishPresence(creator.socketId, Boolean(guest?.ready));
    if (guest?.ready)
      this.transport.publishPresence(guest.socketId, Boolean(creator?.ready));
  }

  async relay(socket: ChatSocket, message: Envelope) {
    this.active++;
    try {
      await this.ensureCurrent(socket);
      const { roomId, participant, token } = socket.data.session;
      await this.rooms.authorize(roomId, token);
      if (!socket.data.ready) throw new ChatError('Session is not ready.');
      const peer = await this.peer(roomId, participant);
      if (!peer?.ready)
        throw new ChatError('Peer is offline. No message was stored.');
      await this.rooms.reserveMessage(roomId, participant, message.id);
      await this.ensureCurrent(socket);
      if (!(await this.presence.isCurrent(peer)))
        throw new ChatError('Connection changed. Delivery was not confirmed.');
      await this.transport.deliver(peer.socketId, {
        ...message,
        sender: participant,
      });
    } finally {
      this.active--;
    }
  }

  private async ensureCurrent(socket: ChatSocket) {
    this.assertAccepting();
    const local = this.connections.get(socket.id);
    const owned =
      local && (await this.presence.isCurrent(socket.data.ownership));
    this.assertAccepting();
    if (
      !local ||
      local.redisGeneration !== this.redis.generation ||
      performance.now() >= local.deadline ||
      !socket.connected ||
      !owned
    ) {
      throw new ChatError('Connection replaced.');
    }
  }

  expireRoom(roomId: string) {
    for (const { socket } of this.connections.values()) {
      if (socket.data.session.roomId === roomId) {
        socket.emit('expired');
        socket.disconnect(true);
      }
    }
  }

  async reconcile() {
    const locals = [...this.connections.values()];
    for (const local of locals) {
      if (performance.now() >= local.deadline) {
        local.socket.emit('expired');
        local.socket.disconnect(true);
      }
    }
    this.redis.assertReady();
    if (performance.now() - this.lastRenewal >= RENEW_MS) {
      const live = [...this.connections.values()];
      for (let offset = 0; offset < live.length; offset += 100) {
        const batch = live.slice(offset, offset + 100);
        const owned = await this.presence.renew(
          batch.map(({ socket }) => socket.data.ownership),
        );
        batch.forEach(({ socket }, index) => {
          if (!owned[index]) {
            socket.emit('replaced');
            socket.disconnect(true);
          }
        });
      }
      this.lastRenewal = performance.now();
    }
    for (const roomId of new Set(
      [...this.connections.values()].map(
        ({ socket }) => socket.data.session.roomId,
      ),
    )) {
      await this.publishPresence(roomId);
    }
  }

  async onModuleDestroy() {
    this.state.drain();
    clearInterval(this.timer);
    const deadline = performance.now() + 5500;
    while (this.active && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await this.maintenance;
    const owned: Ownership[] = [];
    for (const { socket } of this.connections.values()) {
      owned.push(socket.data.ownership);
      socket.disconnect(true);
    }
    if (this.redis.ready) {
      await Promise.all(
        owned.map((owner) => this.presence.detach(owner)),
      ).catch(() => {
        this.logger.error('Shutdown lease release failed; leases will expire.');
      });
    }
    await Promise.allSettled([...this.disconnects]);
    this.removeFailureListener?.();
  }
}
