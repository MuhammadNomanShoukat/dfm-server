import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/httpError.js';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: err.errors[0]?.message ?? 'Invalid request.',
      },
    });
    return;
  }

  logger.error('unhandled_error', {
    message: err instanceof Error ? err.message : 'unknown',
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProd ? 'Something went wrong.' : err instanceof Error ? err.message : 'Unknown error',
    },
  });
}
