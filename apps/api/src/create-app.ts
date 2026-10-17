import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';
import { DatabaseService } from './database/database.service';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  try {
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
