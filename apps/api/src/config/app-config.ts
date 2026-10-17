export class AppConfig {
  readonly databaseUrl: string;
  readonly webOrigin: string;
  readonly port: number;

  constructor() {
    const values = loadConfiguration();
    this.databaseUrl = values.databaseUrl;
    this.webOrigin = values.webOrigin;
    this.port = values.port;
  }
}

function loadConfiguration() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
  if (new URL(webOrigin).origin !== webOrigin) {
    throw new Error(
      'WEB_ORIGIN must be an exact origin without a trailing slash',
    );
  }
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  return { databaseUrl, webOrigin, port };
}
