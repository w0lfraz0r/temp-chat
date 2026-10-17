import type {
  ClientEvents,
  RoomSession,
  ServerEvents,
} from '@temp-chat/protocol';
import type { Server, Socket } from 'socket.io';

interface SocketData {
  session: RoomSession;
  ready: boolean;
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
