import { Inject, Injectable } from '@nestjs/common';
import {
  credentialsSchema,
  type Envelope,
  type Participant,
} from '@temp-chat/protocol';
import { AppConfig } from '../config/app-config';
import { PresenceService } from '../presence/presence.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { RoomsService } from '../rooms/rooms.service';
import { ChatError } from './chat.error';
import { ChatTransport } from './chat.transport';
import type { ChatSocket } from './chat.types';

@Injectable()
export class ChatService {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(ChatTransport) private readonly transport: ChatTransport,
  ) {}

  async authenticate(socket: ChatSocket) {
    if (socket.handshake.headers.origin !== this.config.webOrigin) {
      throw new ChatError('Origin not allowed.');
    }
    this.limits.take(`socket:${socket.handshake.address}`, 60, 60_000);
    const parsed = credentialsSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) throw new ChatError('Invalid session credentials.');
    socket.data.session = await this.rooms.authorize(
      parsed.data.roomId,
      parsed.data.token,
    );
    socket.data.ready = false;
  }

  connect(socket: ChatSocket) {
    const { roomId, participant } = socket.data.session;
    const previous = this.presence.attach(roomId, participant, socket.id);
    if (previous) this.transport.replace(previous);
    this.publishPresence(roomId);
  }

  disconnect(socket: ChatSocket) {
    if (!socket.data.session) return;
    const { roomId, participant } = socket.data.session;
    this.presence.detach(roomId, participant, socket.id);
    this.publishPresence(roomId);
  }

  async ready(socket: ChatSocket) {
    const { roomId, participant, token } = socket.data.session;
    this.limits.take(`ready:${roomId}:${participant}`, 20, 60_000);
    const session = await this.rooms.authorize(roomId, token);
    if (!this.isCurrent(socket)) throw new ChatError('Connection replaced.');
    socket.data.ready = true;
    return { ...session, peerOnline: this.peerReady(roomId, participant) };
  }

  takeMessageLimit(socket: ChatSocket) {
    const { roomId, participant } = socket.data.session;
    this.limits.take(`message:${roomId}:${participant}`, 60, 60_000);
  }

  expireRoom(roomId: string) {
    for (const participant of ['creator', 'guest'] as const) {
      const id = this.presence.socket(roomId, participant);
      if (id) this.transport.expire(id);
    }
  }

  publishPresence(roomId: string) {
    for (const participant of ['creator', 'guest'] as const) {
      const id = this.presence.socket(roomId, participant);
      if (id)
        this.transport.publishPresence(id, this.peerReady(roomId, participant));
    }
  }

  async relay(socket: ChatSocket, message: Envelope) {
    const { roomId, participant, token } = socket.data.session;
    await this.rooms.authorize(roomId, token);
    if (!this.isCurrent(socket) || !socket.data.ready) {
      throw new ChatError('Session is not ready.');
    }
    const peerId = this.presence.peer(roomId, participant);
    if (
      !peerId ||
      !this.transport.isConnected(peerId) ||
      !this.transport.isReady(peerId)
    ) {
      throw new ChatError('Peer is offline. No message was stored.');
    }
    await this.rooms.reserveMessage(roomId, participant, message.id);
    // Recheck after the database await: disconnects and replacements may race it.
    if (!this.isCurrent(socket) || !this.transport.isConnected(peerId)) {
      throw new ChatError('Connection changed. Delivery was not confirmed.');
    }
    await this.transport.deliver(peerId, { ...message, sender: participant });
  }

  private isCurrent(socket: ChatSocket) {
    const { roomId, participant } = socket.data.session;
    return (
      socket.connected &&
      this.presence.socket(roomId, participant) === socket.id
    );
  }

  private peerReady(roomId: string, participant: Participant) {
    const id = this.presence.peer(roomId, participant);
    return Boolean(id && this.transport.isReady(id));
  }
}
