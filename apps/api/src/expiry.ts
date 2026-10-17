import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ChatGateway, ChatModule } from './chat';
import { RoomsModule, RoomsService } from './rooms';

@Injectable()
export class ExpiryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(ExpiryService.name);

  constructor(
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(ChatGateway) private readonly chat: ChatGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.running) {
        this.running = this.tick().finally(() => { this.running = undefined; });
      }
    }, 1000).unref();
  }

  async tick() {
    try {
      for (const id of await this.rooms.deleteExpired()) {
        this.chat.expireRoom(id);
      }
    } catch {
      this.logger.error('Expiry cleanup failed; retrying on the next tick.');
    }
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }
}

@Module({ imports: [RoomsModule, ChatModule], providers: [ExpiryService] })
export class ExpiryModule {}
