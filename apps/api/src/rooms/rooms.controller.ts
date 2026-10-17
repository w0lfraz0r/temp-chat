import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createRoomSchema,
  joinRoomSchema,
  roomIdSchema,
} from '@temp-chat/protocol';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { HttpRateLimitGuard } from '../rate-limit/http-rate-limit.guard';
import { RateLimited } from '../rate-limit/rate-limit.decorator';
import type { CreateRoomDto, JoinRoomDto } from './dto/room.dto';
import { RoomsService } from './rooms.service';

@Controller('rooms')
@UseGuards(HttpRateLimitGuard)
export class RoomsController {
  constructor(@Inject(RoomsService) private readonly rooms: RoomsService) {}

  @Post()
  @RateLimited({ action: 'create', limit: 10, windowMs: 60 * 60_000 })
  create(
    @Body(new ZodValidationPipe(createRoomSchema, 'Invalid room request.'))
    body: CreateRoomDto,
  ) {
    return this.rooms.create(body.guestAccessToken);
  }

  @Post(':id/join')
  @RateLimited({ action: 'join', limit: 30, windowMs: 60_000 })
  join(
    @Param('id', new ZodValidationPipe(roomIdSchema, 'Invalid invitation.'))
    id: string,
    @Body(new ZodValidationPipe(joinRoomSchema, 'Invalid invitation.'))
    body: JoinRoomDto,
  ) {
    return this.rooms.join(id, body.guestAccessToken);
  }
}
