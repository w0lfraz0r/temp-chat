import { HttpException, Inject, Logger } from '@nestjs/common';
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  envelopeSchema,
  type Presence,
  type Result,
  type RoomSession,
} from '@temp-chat/protocol';
import { ChatError } from './chat.error';
import { ChatService } from './chat.service';
import { ChatTransport } from './chat.transport';
import type { ChatServer, ChatSocket } from './chat.types';

type Acknowledge<T = undefined> = (result: Result<T>) => void;

@WebSocketGateway({
  transports: ['websocket'],
  maxHttpBufferSize: 8192,
  connectTimeout: 10_000,
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatTransport) private readonly transport: ChatTransport,
  ) {}

  afterInit(server: ChatServer) {
    this.transport.initialize(server);
    server.use(async (socket, next) => {
      try {
        await this.chat.authenticate(socket);
        next();
      } catch (error) {
        if (error instanceof HttpException || error instanceof ChatError) {
          next(new Error(error.message));
        } else {
          this.logger.error(
            'Socket authorization failed: database unavailable.',
          );
          next(new Error('Unable to authorize session. Try again.'));
        }
      }
    });
  }

  handleConnection(socket: ChatSocket) {
    this.chat.connect(socket);
  }

  handleDisconnect(socket: ChatSocket) {
    this.chat.disconnect(socket);
  }

  @SubscribeMessage('ready')
  async ready(
    @ConnectedSocket() socket: ChatSocket,
    @Ack() ack: Acknowledge<RoomSession & Presence> | undefined,
  ) {
    if (typeof ack !== 'function') return void socket.disconnect(true);
    try {
      const session = await this.chat.ready(socket);
      ack({ ok: true, data: session });
      this.chat.publishPresence(session.roomId);
    } catch (error) {
      ack(this.failure(error));
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('message')
  async message(
    @ConnectedSocket() socket: ChatSocket,
    @MessageBody() body: unknown,
    @Ack() ack: Acknowledge | undefined,
  ) {
    if (typeof ack !== 'function') return void socket.disconnect(true);
    try {
      this.chat.takeMessageLimit(socket);
      const parsed = envelopeSchema.safeParse(body);
      if (!parsed.success) throw new ChatError('Invalid encrypted message.');
      await this.chat.relay(socket, parsed.data);
      ack({ ok: true, data: undefined });
    } catch (error) {
      ack(this.failure(error));
    }
  }

  private failure(error: unknown): Result<never> {
    if (error instanceof HttpException || error instanceof ChatError) {
      return { ok: false, error: error.message };
    }
    this.logger.error('Chat operation failed: database or relay unavailable.');
    return {
      ok: false,
      error: 'Service unavailable. Please reconnect and try again.',
    };
  }
}
