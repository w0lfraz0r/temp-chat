import type { createRoomSchema, joinRoomSchema } from '@temp-chat/protocol';
import type { z } from 'zod';

export type CreateRoomDto = z.infer<typeof createRoomSchema>;
export type JoinRoomDto = z.infer<typeof joinRoomSchema>;
