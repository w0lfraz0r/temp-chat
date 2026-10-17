import {
  envelopeSchema,
  MAX_MESSAGE_BYTES,
  roomIdSchema,
  tokenSchema,
  type Envelope,
  type Participant,
} from '@temp-chat/protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const KDF_ITERATIONS = 600_000;

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (character) => character.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw new Error('Invalid base64url encoding.');
  return bytes;
}

export function newInviteSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function validatePassphrase(passphrase: string) {
  if (passphrase.length < 16 || passphrase.length > 256) {
    throw new Error('Use a passphrase between 16 and 256 characters.');
  }
}

export async function deriveKeys(secret: string, passphrase: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Encryption requires HTTPS or localhost in a modern browser.');
  }
  validatePassphrase(passphrase);
  tokenSchema.parse(secret);
  const password = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits'],
  );
  const root = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unbase64url(secret), iterations: KDF_ITERATIONS },
    password,
    256,
  );
  const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const encryptionKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode('temporary-chat:v1:encryption') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const admission = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode('temporary-chat:v1:admission') },
    material, 256,
  );
  return { encryptionKey, guestAccessToken: base64url(new Uint8Array(admission)) };
}

function additionalData(roomId: string, sender: Participant, id: string) {
  return encoder.encode(JSON.stringify(['temporary-chat', 1, roomId, sender, id]));
}

export async function encrypt(
  key: CryptoKey, roomId: string, sender: Participant, text: string,
): Promise<Envelope> {
  const plaintext = encoder.encode(text);
  if (!text.trim() || plaintext.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(`Messages must contain 1-${MAX_MESSAGE_BYTES} UTF-8 bytes.`);
  }
  const id = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(roomId, sender, id), tagLength: 128 },
    key, plaintext,
  );
  return { id, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

export async function decrypt(
  key: CryptoKey, roomId: string, sender: Participant, message: Envelope,
): Promise<string> {
  envelopeSchema.parse(message);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM', iv: unbase64url(message.iv),
      additionalData: additionalData(roomId, sender, message.id), tagLength: 128,
    },
    key, unbase64url(message.ciphertext),
  );
  if (plaintext.byteLength > MAX_MESSAGE_BYTES) throw new Error('Message too large.');
  const text = decoder.decode(plaintext);
  if (!text.trim()) throw new Error('Empty message.');
  return text;
}

export interface Invite {
  roomId: string;
  secret: string;
}

export function parseInvite(hash: string): Invite | undefined {
  if (!hash || hash === '#') return undefined;
  const params = new URLSearchParams(hash.slice(1));
  if (params.get('v') !== '1') throw new Error('Invalid or unsupported invitation.');
  const roomId = roomIdSchema.parse(params.get('room'));
  const secret = tokenSchema.parse(params.get('key'));
  unbase64url(secret);
  return { roomId, secret };
}

export function inviteUrl(invite: Invite) {
  const url = new URL(window.location.origin + window.location.pathname);
  url.hash = new URLSearchParams({ v: '1', room: invite.roomId, key: invite.secret }).toString();
  return url.toString();
}
