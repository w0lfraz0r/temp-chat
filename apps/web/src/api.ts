import { roomSessionSchema, type RoomSession } from '@temp-chat/protocol';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export async function postSession(path: string, body: object): Promise<RoomSession> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error: unknown = await response.json();
    const message =
      typeof error === 'object' && error !== null && 'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return roomSessionSchema.parse(await response.json());
}
