import { roomSessionSchema, tokenSchema } from '@temp-chat/protocol';
import { z } from 'zod';

const STORAGE_KEY = 'temporary-chat:v1:session';
const savedSchema = z.object({
  room: roomSessionSchema,
  secret: tokenSchema,
  keyCheck: tokenSchema,
});
export type SavedSession = z.infer<typeof savedSchema>;

export function loadSession(): SavedSession | undefined {
  const saved = sessionStorage.getItem(STORAGE_KEY);
  return saved ? savedSchema.parse(JSON.parse(saved)) : undefined;
}

export function saveSession(session: SavedSession) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function forgetSession() {
  sessionStorage.removeItem(STORAGE_KEY);
}
