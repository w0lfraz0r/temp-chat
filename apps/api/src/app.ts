import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import helmet from 'helmet';
import { ChatModule } from './chat';
import { config } from './config';
import { Database } from './database';
import { ExpiryModule } from './expiry';
import { RoomsModule } from './rooms';

@Module({ imports: [RoomsModule, ChatModule, ExpiryModule] })
export class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(helmet());
  app.use(json({ limit: '8kb' }));
  app.enableCors({ origin: config().webOrigin, methods: ['POST'] });
  app.enableShutdownHooks();
  await app.get(Database).pool.query('SELECT 1');
  return app;
}
