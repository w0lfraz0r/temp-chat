import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(AppConfig) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    this.pool.on('error', () => {
      this.logger.error('An idle PostgreSQL connection failed.');
    });
  }

  async verifyConnection() {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
