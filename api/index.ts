import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';

type ExpressHandler = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<Express> | null = null;

function loadApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = import('../src/app.js')
      .then((mod) => mod.createApp())
      .catch((error: unknown) => {
        appPromise = null;
        const message = error instanceof Error ? error.message : 'Failed to start HerdOS API';
        console.error('herdos_vercel_boot_failed', message);
        throw new Error(message);
      });
  }
  return appPromise;
}

/**
 * Vercel serverless handler — boots Express lazily and returns JSON if env/boot fails.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const expressApp = (await loadApp()) as unknown as ExpressHandler;
    expressApp(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Boot failed';
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 'BOOT_FAILED',
            message,
            hint: 'In Vercel → Settings → Environment Variables set DATABASE_URL (Neon) and JWT_SECRET (min 16 chars), then Redeploy.',
          },
        }),
      );
    }
  }
}
