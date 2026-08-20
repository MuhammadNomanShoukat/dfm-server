import { createApp } from '../src/app.js';

/**
 * Vercel serverless entry — Express app (no listen()).
 * Local/dev still uses src/index.ts with http.createServer.
 */
const app = createApp();

export default app;
