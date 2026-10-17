import { Module } from '@nestjs/common';
import { AppConfig } from './app-config';

@Module({
  providers: [{ provide: AppConfig, useFactory: () => new AppConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
