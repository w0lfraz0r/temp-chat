import { Injectable } from '@nestjs/common';
import type { IncomingMessage, Result } from '@temp-chat/protocol';
import { ChatError } from './chat.error';
import type { ChatServer } from './chat.types';

@Injectable()
export class ChatTransport {
  private server?: ChatServer;

  initialize(server: ChatServer) {
    this.server = server;
  }

  replace(id: string) {
    const socket = this.socket(id);
    socket?.emit('replaced');
    socket?.disconnect(true);
  }

  expire(id: string) {
    const socket = this.socket(id);
    socket?.emit('expired');
    socket?.disconnect(true);
  }

  isConnected(id: string) {
    return Boolean(this.socket(id)?.connected);
  }

  isReady(id: string) {
    return Boolean(this.socket(id)?.data.ready);
  }

  publishPresence(id: string, peerOnline: boolean) {
    const socket = this.socket(id);
    if (socket?.data.ready) socket.emit('presence', { peerOnline });
  }

  async deliver(id: string, message: IncomingMessage) {
    const socket = this.socket(id);
    if (!socket?.connected) {
      throw new ChatError('Connection changed. Delivery was not confirmed.');
    }
    let reply: Result;
    try {
      reply = await socket.timeout(5000).emitWithAck('message', message);
    } catch {
      throw new ChatError(
        'Delivery not confirmed. The peer may have received the message.',
      );
    }
    if (!reply || reply.ok !== true) {
      throw new ChatError(
        'Peer could not authenticate the message. Check your passphrase.',
      );
    }
  }

  private socket(id: string) {
    if (!this.server)
      throw new Error('Chat transport has not been initialized.');
    return this.server.sockets.sockets.get(id);
  }
}
