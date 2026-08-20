# HerdOS API (server)

Dairy Farm Management backend — Express + PostgreSQL (Neon) + optional Ollama.

## Local run

```bash
copy .env.example .env
npm install
npm run db:setup
npm run dev
```

API: http://localhost:4000/api/health

## Deploy to Vercel

See [DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md).

Required for Vercel:

- `api/index.ts`
- `vercel.json`
- Env vars in Vercel dashboard (`DATABASE_URL`, `JWT_SECRET`, `CLIENT_ORIGIN`, `NODE_ENV`)

Never commit `.env`.
