import { describe, expect, it } from 'vitest';
import { PresenceService } from './presence.service';

describe('presence and socket replacement', () => {
  it('tracks peers and ignores a stale socket disconnect', () => {
    const presence = new PresenceService();
    expect(presence.attach('room', 'creator', 'first')).toBeUndefined();
    presence.attach('room', 'guest', 'guest');
    expect(presence.peer('room', 'creator')).toBe('guest');
    expect(presence.attach('room', 'creator', 'second')).toBe('first');
    presence.detach('room', 'creator', 'first');
    expect(presence.socket('room', 'creator')).toBe('second');
    presence.detach('room', 'creator', 'second');
    expect(presence.peer('room', 'guest')).toBeUndefined();
    presence.detach('room', 'guest', 'guest');
    expect(presence.socket('room', 'guest')).toBeUndefined();
  });
});
