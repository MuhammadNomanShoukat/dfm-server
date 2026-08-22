import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { seed } from './seed.js';

const root = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(root, '../.env') });

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

function databaseUrlHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function applyMigrations(client: pg.Client): Promise<void> {
  const migrated = await client.query(`SELECT to_regclass('public.tenants') AS t`);
  if (!migrated.rows[0]?.t) {
    const sqlPath = path.join(root, '../db/migrations/001_init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    process.stdout.write('Applied 001_init.sql\n');
  } else {
    process.stdout.write('Schema 001 already present\n');
  }

  const enhanced = await client.query(`SELECT to_regclass('public.permissions') AS t`);
  if (!enhanced.rows[0]?.t) {
    const sqlPath = path.join(root, '../db/migrations/002_enhancements.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    process.stdout.write('Applied 002_enhancements.sql\n');
  } else {
    process.stdout.write('Schema 002 already present\n');
  }
}

async function applySchemaAndSeed(client: pg.Client): Promise<void> {
  await applyMigrations(client);
  await seed(client);
}

async function setupFromUrl(databaseUrl: string): Promise<void> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  process.stdout.write('Connected via DATABASE_URL\n');
  await applySchemaAndSeed(client);
  await client.end();
}

async function setupLocal(): Promise<void> {
  const admin = {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
  };
  const dbName = process.env.PGDATABASE ?? 'dairy_farm';
  if (!/^[a-z][a-z0-9_]*$/.test(dbName)) {
    throw new Error('Invalid PGDATABASE name');
  }
  const bootstrap = new pg.Client({ ...admin, database: 'postgres' });
  await bootstrap.connect();
  const found = await bootstrap.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!found.rowCount) {
    await bootstrap.query(`CREATE DATABASE ${dbName}`);
    process.stdout.write(`Created database ${dbName}\n`);
  } else {
    process.stdout.write(`Database ${dbName} already exists\n`);
  }
  await bootstrap.end();

  const farm = new pg.Client({ ...admin, database: dbName });
  await farm.connect();
  await applySchemaAndSeed(farm);
  await farm.end();
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const urlHost = databaseUrl ? databaseUrlHost(databaseUrl) : null;
  if (databaseUrl && urlHost && !isLocalHost(urlHost)) {
    await setupFromUrl(databaseUrl);
  } else {
    await setupLocal();
  }
  process.stdout.write('Database setup complete.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
