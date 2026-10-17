import 'reflect-metadata';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { AppConfig } from '../config/app-config';

export async function migrate(configuration = new AppConfig()) {
  const pool = new Pool({
    connectionString: configuration.databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741852963)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)',
    );
    const directory = path.resolve(__dirname, '../../migrations');
    for (const name of (await readdir(directory))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (applied.rowCount) continue;
      await client.query(await readFile(path.join(directory, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        name,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch((error: unknown) => {
    console.error('Database migration failed', error);
    process.exitCode = 1;
  });
}
