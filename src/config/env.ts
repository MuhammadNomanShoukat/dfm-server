import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const root = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(root, '../../.env') });

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5151,http://127.0.0.1:5151,http://172.16.3.140:5151'),
  DATABASE_URL: z.string().min(1),
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().default(5432),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().default('unused'),
  PGDATABASE: z.string().default('dairy_farm'),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('8h'),
  MFA_TOKEN_EXPIRES_IN: z.string().default('2m'),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3'),
  COOKIE_NAME: z.string().default('herdos_token'),
});

export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === 'production';

export const clientOrigins = env.CLIENT_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  if (clientOrigins.includes(origin)) {
    return true;
  }
  return origin.endsWith('.vercel.app');
}
