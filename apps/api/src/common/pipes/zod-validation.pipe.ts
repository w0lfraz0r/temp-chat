import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly message: string,
  ) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException(this.message);
    return parsed.data;
  }
}
