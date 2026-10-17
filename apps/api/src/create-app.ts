import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { DatabaseService } from './database/database.service';
import { RedisService } from './redis/redis.service';
import { RedisIoAdapter } from './redis/redis-io.adapter';
import { ClientAddressService } from './common/client-address.service';

export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    abortOnError: false,
  });
  try {
    const redis = app.get(RedisService);
    await redis.connect();
    app.useWebSocketAdapter(new RedisIoAdapter(app, redis));
    app
      .getHttpAdapter()
      .getInstance()
      .set('trust proxy', app.get(ClientAddressService).trust);
    app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
    app.use(json({ limit: '8kb' }));
    app.enableCors({ origin: app.get(AppConfig).webOrigin, methods: ['POST'] });
    app.enableShutdownHooks();
    await app.get(DatabaseService).verifyConnection();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
