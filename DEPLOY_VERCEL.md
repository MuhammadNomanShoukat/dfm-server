# Deploy HerdOS API (server) to Vercel

This folder is the **API only**. Deploy it as its own Vercel project (or from a separate GitHub repo).

## Files required for Vercel

- `api/index.ts` — serverless entry
- `vercel.json` — route rewrite
- `src/` — Express app
- `package.json`
- `tsconfig.json`
- `db/migrations/` — for local/Neon setup only (not used by Vercel runtime)

## Never upload

- `.env` (secrets)
- `node_modules/`
- `dist/`

## Vercel dashboard settings

| Setting | Value |
|---------|--------|
| Root Directory | `.` (repo root if this folder IS the repo) |
| Framework | Other |
| Build Command | *(leave empty)* |
| Output Directory | *(leave empty)* |
| Install Command | `npm install` |

## Environment variables (Production)

| Name | Example |
|------|---------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon URL for `dairy_farm` (`sslmode=require`, prefer **pooler**) |
| `JWT_SECRET` | 16+ random characters |
| `CLIENT_ORIGIN` | `https://your-ui.vercel.app` (set after UI deploy) |
| `HOST` | `0.0.0.0` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | `llama3` |
| `COOKIE_NAME` | `herdos_token` |

## After deploy

Open: `https://YOUR-API.vercel.app/api/health`

Expect: `{ "ok": true, "name": "HerdOS", ... }`

Then put that API URL into the **client** as `VITE_API_URL` (no `/api`, no trailing slash).
