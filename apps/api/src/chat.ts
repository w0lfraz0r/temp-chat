import { HttpException, Inject, Logger, Module } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  credentialsSchema,
  envelopeSchema,
  type ClientEvents,
  type Envelope,
  type Result,
  type RoomSession,
  type ServerEvents,
} from '@temp-chat/protocol';
import { Server, Socket } from 'socket.io';
import { config } from './config';
import { PresenceModule, PresenceService } from './presence';
import { RateLimit } from './rate-limit';
import { RoomsModule, RoomsService } from './rooms';

interface SocketData {
  session: RoomSession;
  ready: boolean;
}
type ChatSocket = Socket<ClientEvents, ServerEvents, ServerEvents, SocketData>;
type ChatServer = Server<ClientEvents, ServerEvents, ServerEvents, SocketData>;

@WebSocketGateway({
  transports: ['websocket'],
  maxHttpBufferSize: 8192,
  connectTimeout: 10_000,
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() private server!: ChatServer;
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RateLimit) private readonly limits: RateLimit,
  ) {}

  afterInit(server: ChatServer) {
    server.use(async (socket, next) => {
      try {
        if (socket.handshake.headers.origin !== config().webOrigin) {
          throw new Error('Origin not allowed.');
        }
        this.limits.take(`socket:${socket.handshake.address}`, 60, 60_000);
        const parsed = credentialsSchema.safeParse(socket.handshake.auth);
        if (!parsed.success) throw new Error('Invalid session credentials.');
        socket.data.session = await this.rooms.authorize(
          parsed.data.roomId,
          parsed.data.token,
        );
        socket.data.ready = false;
        next();
      } catch (error) {
        const message =
          error instanceof HttpException
            ? error.message
            : error instanceof Error &&
                ['Origin not allowed.', 'Invalid session credentials.'].includes(error.message)
              ? error.message
              : 'Unable to authorize session. Try again.';
        if (!(error instanceof HttpException) && message.startsWith('Unable')) {
          this.logger.error('Socket authorization failed: database unavailable.');
        }
        next(new Error(message));
      }
    });
  }

  handleConnection(socket: ChatSocket) {
    const { roomId, participant } = socket.data.session;
    const previous = this.presence.attach(roomId, participant, socket.id);
    if (previous) {
      const old = this.server.sockets.sockets.get(previous);
      old?.emit('replaced');
      old?.disconnect(true);
    }
    socket.on('ready', async (ack) => {
      if (typeof ack !== 'function') return socket.disconnect(true);
      try {
        this.limits.take(`ready:${roomId}:${participant}`, 20, 60_000);
        const session = await this.rooms.authorize(roomId, socket.data.session.token);
        if (!this.isCurrent(socket)) throw new Error('Connection replaced.');
        socket.data.ready = true;
        ack({
          ok: true,
          data: { ...session, peerOnline: this.peerReady(socket) },
        });
        this.publishPresence(roomId);
      } catch (error) {
        ack(this.failure(error));
        socket.disconnect(true);
      }
    });
    socket.on('message', async (body, ack) => {
      if (typeof ack !== 'function') return socket.disconnect(true);
      try {
        this.limits.take(`message:${roomId}:${participant}`, 60, 60_000);
        const parsed = envelopeSchema.safeParse(body);
        if (!parsed.success) throw new Error('Invalid encrypted message.');
        await this.relay(socket, parsed.data);
        ack({ ok: true, data: undefined });
      } catch (error) {
        ack(this.failure(error));
      }
    });
    this.publishPresence(roomId);
  }

  handleDisconnect(socket: ChatSocket) {
    if (!socket.data.session) return;
    const { roomId, participant } = socket.data.session;
    this.presence.detach(roomId, participant, socket.id);
    this.publishPresence(roomId);
  }

  expireRoom(roomId: string) {
    for (const participant of ['creator', 'guest'] as const) {
      const id = this.presence.socket(roomId, participant);
      const socket = id ? this.server.sockets.sockets.get(id) : undefined;
      socket?.emit('expired');
      socket?.disconnect(true);
    }
  }

  private isCurrent(socket: ChatSocket) {
    const { roomId, participant } = socket.data.session;
    return socket.connected && this.presence.socket(roomId, participant) === socket.id;
  }

  private peerReady(socket: ChatSocket) {
    const { roomId, participant } = socket.data.session;
    const id = this.presence.peer(roomId, participant);
    return Boolean(id && this.server.sockets.sockets.get(id)?.data.ready);
  }

  private publishPresence(roomId: string) {
    for (const participant of ['creator', 'guest'] as const) {
      const id = this.presence.socket(roomId, participant);
      const socket = id ? this.server.sockets.sockets.get(id) : undefined;
      if (socket?.data.ready) {
        socket.emit('presence', { peerOnline: this.peerReady(socket) });
      }
    }
  }

  private async relay(socket: ChatSocket, message: Envelope) {
    const { roomId, participant, token } = socket.data.session;
    await this.rooms.authorize(roomId, token);
    if (!this.isCurrent(socket) || !socket.data.ready) {
      throw new Error('Session is not ready.');
    }
    const peerId = this.presence.peer(roomId, participant);
    const peer = peerId ? this.server.sockets.sockets.get(peerId) : undefined;
    if (!peer?.connected || !peer.data.ready) {
      throw new Error('Peer is offline. No message was stored.');
    }
    await this.rooms.reserveMessage(roomId, participant, message.id);
    // Recheck after the database await: disconnects and replacements may race it.
    if (!this.isCurrent(socket) || !peer.connected) {
      throw new Error('Connection changed. Delivery was not confirmed.');
    }
    let reply: Result;
    try {
      reply = await peer.timeout(5000).emitWithAck('message', {
        ...message,
        sender: participant,
      });
    } catch {
      throw new Error('Delivery not confirmed. The peer may have received the message.');
    }
    if (!reply || reply.ok !== true) {
      throw new Error('Peer could not authenticate the message. Check your passphrase.');
    }
  }

  private failure(error: unknown): Result<never> {
    if (error instanceof HttpException) return { ok: false, error: error.message };
    const expected = [
      'Invalid encrypted message.',
      'Session is not ready.',
      'Connection replaced.',
      'Peer is offline. No message was stored.',
      'Connection changed. Delivery was not confirmed.',
      'Delivery not confirmed. The peer may have received the message.',
      'Peer could not authenticate the message. Check your passphrase.',
    ];
    if (error instanceof Error && expected.includes(error.message)) {
      return { ok: false, error: error.message };
    }
    this.logger.error('Chat operation failed: database or relay unavailable.');
    return { ok: false, error: 'Service unavailable. Please reconnect and try again.' };
  }
}

@Module({
  imports: [RoomsModule, PresenceModule],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class ChatModule {}
