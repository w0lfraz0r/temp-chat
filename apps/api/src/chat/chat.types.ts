import type {
  ClientEvents,
  RoomSession,
  ServerEvents,
} from '@temp-chat/protocol';
import type { Server, Socket } from 'socket.io';
import type { Ownership } from '../presence/presence.service';

interface SocketData {
  session: RoomSession;
  ready: boolean;
  ownership: Ownership;
}

export type ChatSocket = Socket<
  ClientEvents,
  ServerEvents,
  ServerEvents,
  SocketData
>;
export type ChatServer = Server<
  ClientEvents,
  ServerEvents,
  ServerEvents,
  SocketData
>;
