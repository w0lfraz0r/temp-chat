import { BadRequestException } from '@nestjs/common';
import { createRoomSchema } from '@temp-chat/protocol';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(createRoomSchema, 'Invalid room request.');

  it('returns the validated DTO without accepting unknown fields', () => {
    const dto = { guestAccessToken: 'a'.repeat(43) };
    expect(pipe.transform(dto)).toEqual(dto);
    expect(() => pipe.transform({ ...dto, unexpected: true })).toThrow(
      BadRequestException,
    );
  });

  it.each([null, undefined, {}, { guestAccessToken: 'bad' }])(
    'preserves the public validation error for %j',
    (body) => {
      expect(() => pipe.transform(body)).toThrow('Invalid room request.');
    },
  );
});
