import http from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { attachSocket } from './ws/index.js';
import { pool } from './db/pool.js';

const app = createApp();

if (!process.env.VERCEL) {
  const server = http.createServer(app);
  attachSocket(server);

  server.listen(env.PORT, env.HOST, () => {
    logger.info('herdos_listening', { host: env.HOST, port: env.PORT, origins: env.CLIENT_ORIGIN });
  });

  async function shutdown(): Promise<void> {
    server.close();
    await pool.end();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

export default app;
