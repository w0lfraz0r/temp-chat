import { Injectable, Module } from '@nestjs/common';
import type { Participant } from '@temp-chat/protocol';

@Injectable()
export class PresenceService {
  private readonly rooms = new Map<string, Map<Participant, string>>();

  attach(roomId: string, participant: Participant, socketId: string) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    const previous = room.get(participant);
    room.set(participant, socketId);
    return previous;
  }

  detach(roomId: string, participant: Participant, socketId: string) {
    const room = this.rooms.get(roomId);
    if (room?.get(participant) !== socketId) return;
    room.delete(participant);
    if (!room.size) this.rooms.delete(roomId);
  }

  socket(roomId: string, participant: Participant) {
    return this.rooms.get(roomId)?.get(participant);
  }

  peer(roomId: string, participant: Participant) {
    return this.socket(roomId, participant === 'creator' ? 'guest' : 'creator');
  }
}

@Module({ providers: [PresenceService], exports: [PresenceService] })
export class PresenceModule {}
