import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  base64url,
  decrypt,
  deriveKeys,
  encrypt,
  newInviteSecret,
  parseInvite,
  unbase64url,
} from './crypto';

describe('browser encryption protocol v1', () => {
  const secret = newInviteSecret();
  const passphrase = 'a unique random test passphrase';
  const roomId = randomUUID();
  let creator: Awaited<ReturnType<typeof deriveKeys>>;
  let guest: Awaited<ReturnType<typeof deriveKeys>>;
  let wrong: Awaited<ReturnType<typeof deriveKeys>>;

  beforeAll(async () => {
    [creator, guest, wrong] = await Promise.all([
      deriveKeys(secret, passphrase),
      deriveKeys(secret, passphrase),
      deriveKeys(secret, 'a completely different passphrase'),
    ]);
  });

  it('derives matching, non-extractable keys and an independent admission token', async () => {
    expect(creator.guestAccessToken).toBe(guest.guestAccessToken);
    expect(creator.guestAccessToken).not.toBe(wrong.guestAccessToken);
    await expect(crypto.subtle.exportKey('raw', creator.encryptionKey)).rejects.toThrow();
  });

  it('round-trips Unicode without exposing plaintext in the envelope', async () => {
    const text = 'hello \u{1F30D}\nsecond line';
    const message = await encrypt(creator.encryptionKey, roomId, 'creator', text);
    expect(await decrypt(guest.encryptionKey, roomId, 'creator', message)).toBe(text);
    const incoming = { ...message, sender: 'creator' as const };
    expect(await decrypt(guest.encryptionKey, roomId, incoming.sender, incoming)).toBe(text);
    expect(Object.keys(message).sort()).toEqual(['ciphertext', 'id', 'iv']);
    expect(JSON.stringify(message)).not.toContain(text);
  });

  it('uses fresh IVs and message IDs for identical messages', async () => {
    const first = await encrypt(creator.encryptionKey, roomId, 'creator', 'hello');
    const second = await encrypt(creator.encryptionKey, roomId, 'creator', 'hello');
    expect(first.iv).not.toBe(second.iv);
    expect(first.id).not.toBe(second.id);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects incorrect passphrases and modified ciphertext, IV, ID, room, or sender', async () => {
    const message = await encrypt(creator.encryptionKey, roomId, 'creator', 'authentic message');
    const ciphertext = unbase64url(message.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 1;
    const iv = unbase64url(message.iv);
    iv[0] = iv[0]! ^ 1;
    for (const [key, room, sender, envelope] of [
      [wrong.encryptionKey, roomId, 'creator', message],
      [guest.encryptionKey, randomUUID(), 'creator', message],
      [guest.encryptionKey, roomId, 'guest', message],
      [guest.encryptionKey, roomId, 'creator', { ...message, id: randomUUID() }],
      [guest.encryptionKey, roomId, 'creator', { ...message, iv: base64url(iv) }],
      [guest.encryptionKey, roomId, 'creator', { ...message, ciphertext: base64url(ciphertext) }],
    ] as const) {
      await expect(decrypt(key, room, sender, envelope)).rejects.toThrow();
    }
  });

  it('enforces byte limits rather than character counts', async () => {
    const text = '\u{1F30D}'.repeat(1000);
    const message = await encrypt(creator.encryptionKey, roomId, 'creator', text);
    expect(await decrypt(guest.encryptionKey, roomId, 'creator', message)).toBe(text);
    await expect(encrypt(creator.encryptionKey, roomId, 'creator', text + 'a')).rejects.toThrow('UTF-8 bytes');
    await expect(encrypt(creator.encryptionKey, roomId, 'creator', ' \n ')).rejects.toThrow();
  });

  it('validates invitation versions, identifiers, and secrets', () => {
    expect(parseInvite('')).toBeUndefined();
    expect(parseInvite(`#v=1&room=${roomId}&key=${secret}`)).toEqual({ roomId, secret });
    expect(() => parseInvite(`#v=2&room=${roomId}&key=${secret}`)).toThrow();
    expect(() => parseInvite(`#v=1&room=nope&key=${secret}`)).toThrow();
    expect(() => unbase64url('AA=')).toThrow();
  });

  it('rejects short or unbounded passphrases', async () => {
    await expect(deriveKeys(secret, 'short')).rejects.toThrow('16 and 256');
    await expect(deriveKeys(secret, 'a'.repeat(257))).rejects.toThrow('16 and 256');
  });
});
