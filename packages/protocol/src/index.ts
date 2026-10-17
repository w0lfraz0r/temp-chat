import { z } from 'zod';

export const ROOM_LIFETIME_MS = 60 * 60 * 1000;
export const MAX_MESSAGE_BYTES = 4000;
export const MAX_MESSAGES_PER_ROOM = 4096;
export const participantSchema = z.enum(['creator', 'guest']);
export type Participant = z.infer<typeof participantSchema>;
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const roomIdSchema = z.string().uuid();
export const createRoomSchema = z.object({ guestAccessToken: tokenSchema }).strict();
export const joinRoomSchema = z.object({ guestAccessToken: tokenSchema }).strict();
export const credentialsSchema = z
  .object({ roomId: roomIdSchema, token: tokenSchema })
  .strict();
export const envelopeSchema = z
  .object({
    id: z.string().uuid(),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z.string().min(23).max(5355).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export const incomingMessageSchema = envelopeSchema.extend({ sender: participantSchema });
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export const roomSessionSchema = credentialsSchema.extend({
  participant: participantSchema,
  expiresAt: z.string().datetime(),
  serverTime: z.string().datetime(),
});
export type RoomSession = z.infer<typeof roomSessionSchema>;
export type Result<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };
export interface Presence {
  peerOnline: boolean;
}
export interface ServerEvents {
  presence: (presence: Presence) => void;
  message: (message: IncomingMessage, ack: (result: Result) => void) => void;
  expired: () => void;
  replaced: () => void;
}
export interface ClientEvents {
  message: (message: Envelope, ack: (result: Result) => void) => void;
  ready: (ack: (result: Result<RoomSession & Presence>) => void) => void;
}
