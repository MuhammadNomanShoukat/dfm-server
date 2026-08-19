import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const needsSsl = /sslmode=require/i.test(env.DATABASE_URL);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (error) => {
  logger.error('pg_pool_error', { message: error.message });
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
