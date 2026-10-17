import { Inject, Injectable } from '@nestjs/common';
import type { Participant } from '@temp-chat/protocol';
import { z } from 'zod';
import { RedisService } from '../redis/redis.service';

export const LEASE_MS = 30_000;
export const RENEW_MS = 10_000;
export const RECONCILE_MS = 2000;

const ownershipSchema = z.object({
  roomId: z.string(),
  participant: z.enum(['creator', 'guest']),
  socketId: z.string(),
  generation: z.string(),
  replicaId: z.string(),
  ready: z.boolean(),
  deadline: z.number(),
});
export type Ownership = z.infer<typeof ownershipSchema>;
export type Claim = Omit<Ownership, 'ready' | 'deadline'>;

const CLAIM = `
local previous = redis.call('GET', KEYS[1])
local now = redis.call('TIME')
local milliseconds = now[1] * 1000 + math.floor(now[2] / 1000)
local record = cjson.decode(ARGV[1])
record.ready = false
record.deadline = milliseconds + tonumber(ARGV[2])
local ttl = math.min(tonumber(ARGV[2]), tonumber(ARGV[3]))
if ttl <= 0 then return redis.error_reply('Room expired') end
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded, 'PX', ttl)
return {previous or '', encoded}
`;

const READY = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local record = cjson.decode(value)
if record.generation ~= ARGV[1] then return 0 end
record.ready = true
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
`;

const DETACH = `
local value = redis.call('GET', KEYS[1])
if value and cjson.decode(value).generation == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW = `
local now = redis.call('TIME')
local milliseconds = now[1] * 1000 + math.floor(now[2] / 1000)
local result = {}
for i, key in ipairs(KEYS) do
  local value = redis.call('GET', key)
  local owned = 0
  if value then
    local record = cjson.decode(value)
    if record.generation == ARGV[i] then
      local ttl = math.min(record.deadline - milliseconds, 30000)
      if ttl > 0 then
        redis.call('PEXPIRE', key, ttl)
        owned = 1
      else
        redis.call('DEL', key)
      end
    end
  end
  result[i] = owned
end
return result
`;

@Injectable()
export class PresenceService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  private key(roomId: string, participant: Participant) {
    return this.redis.key(`presence:${roomId}:${participant}`);
  }

  async attach(claim: Claim, remainingMs: number) {
    const result = await this.redis.run(() =>
      this.redis.command.eval(CLAIM, {
        keys: [this.key(claim.roomId, claim.participant)],
        arguments: [
          JSON.stringify(claim),
          String(Math.floor(remainingMs)),
          String(LEASE_MS),
        ],
      }),
    );
    const values = z.tuple([z.string(), z.string()]).parse(result);
    return {
      previous: values[0]
        ? ownershipSchema.parse(JSON.parse(values[0]))
        : undefined,
      current: ownershipSchema.parse(JSON.parse(values[1])),
    };
  }

  async markReady(owner: Ownership) {
    return (
      (await this.redis.run(() =>
        this.redis.command.eval(READY, {
          keys: [this.key(owner.roomId, owner.participant)],
          arguments: [owner.generation],
        }),
      )) === 1
    );
  }

  async detach(owner: Ownership) {
    return (
      (await this.redis.run(() =>
        this.redis.command.eval(DETACH, {
          keys: [this.key(owner.roomId, owner.participant)],
          arguments: [owner.generation],
        }),
      )) === 1
    );
  }

  async read(
    roomId: string,
    participant: Participant,
  ): Promise<Ownership | undefined> {
    const value = await this.redis.run(() =>
      this.redis.command.get(this.key(roomId, participant)),
    );
    return value ? ownershipSchema.parse(JSON.parse(value)) : undefined;
  }

  async isCurrent(owner: Ownership) {
    return (
      (await this.read(owner.roomId, owner.participant))?.generation ===
      owner.generation
    );
  }

  async renew(owners: Ownership[]): Promise<boolean[]> {
    if (!owners.length) return [];
    const result = await this.redis.run(() =>
      this.redis.command.eval(RENEW, {
        keys: owners.map((owner) => this.key(owner.roomId, owner.participant)),
        arguments: owners.map((owner) => owner.generation),
      }),
    );
    return z
      .array(z.number())
      .parse(result)
      .map((value) => value === 1);
  }
}
