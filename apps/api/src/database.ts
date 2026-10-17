import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from './config';

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly logger = new Logger(Database.name);
  readonly pool = new Pool({
    connectionString: config().databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });

  constructor() {
    this.pool.on('error', () => {
      this.logger.error('An idle PostgreSQL connection failed.');
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
