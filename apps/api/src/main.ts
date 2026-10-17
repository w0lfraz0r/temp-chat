import 'reflect-metadata';
import { createApp } from './app';
import { config } from './config';
import { migrate } from './migrate';

async function main() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      break;
    } catch (error) {
      const retryable = typeof error === 'object' && error !== null && 'code' in error &&
        ['ECONNREFUSED', '57P03', 'EAI_AGAIN'].includes(String(error.code));
      if (!retryable || attempt >= 20) throw error;
      console.warn(`PostgreSQL is not ready; retrying startup (${attempt}/20).`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const app = await createApp();
  await app.listen(config().port, '0.0.0.0');
}

main().catch((error: unknown) => {
  console.error('Backend startup failed', error);
  process.exitCode = 1;
});
