import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Local only — on Vercel, env comes from the dashboard (process.env).
const localEnvPath = join(process.cwd(), '.env');
if (existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  CLIENT_ORIGIN: z
    .string()
    .default('http://localhost:5151,http://127.0.0.1:5151,http://172.16.3.140:5151'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().default(5432),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().default('unused'),
  PGDATABASE: z.string().default('dairy_farm'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  MFA_TOKEN_EXPIRES_IN: z.string().default('2m'),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3'),
  COOKIE_NAME: z.string().default('herdos_token'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`HerdOS env invalid: ${details}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isVercel = Boolean(process.env.VERCEL);

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
