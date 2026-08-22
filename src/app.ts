import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env, isAllowedOrigin } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { farmsRouter } from './modules/farms/farms.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { animalsRouter } from './modules/animals/animals.routes.js';
import { milkingRouter } from './modules/milking/milking.routes.js';
import { breedingRouter } from './modules/breeding/breeding.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { feedRouter } from './modules/feed/feed.routes.js';
import { financeRouter } from './modules/finance/finance.routes.js';
import { employeesRouter } from './modules/employees/employees.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { collectionRouter } from './modules/collection/collection.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { permissionsRouter } from './modules/permissions/permissions.routes.js';
import { subscriptionRouter } from './modules/subscription/subscription.routes.js';
import { syncRouter } from './modules/sync/sync.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed'));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      name: 'HerdOS API',
      message: 'Server is running. Use /api/health or the React client.',
      health: '/api/health',
    });
  });

  app.get('/api', (_req, res) => {
    res.json({
      ok: true,
      name: 'HerdOS API',
      health: '/api/health',
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'HerdOS', time: new Date().toISOString() });
  });

  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/farms', farmsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/animals', animalsRouter);
  app.use('/api/milking', milkingRouter);
  app.use('/api/breeding', breedingRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/feed', feedRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/employees', employeesRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/collection', collectionRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/ai', aiLimiter, aiRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/permissions', permissionsRouter);
  app.use('/api/subscription', subscriptionRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/admin', adminRouter);

  app.use(errorHandler);
  return app;
}
