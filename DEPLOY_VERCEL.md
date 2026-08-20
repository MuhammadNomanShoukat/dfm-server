# Deploy HerdOS API (server) to Vercel

## Files required

- `api/index.ts`
- `vercel.json`
- `src/`
- `package.json`
- `tsconfig.json`

## Never commit

- `.env`
- `node_modules/`
- `dist/`

## Vercel dashboard settings

| Setting | Value |
|---------|--------|
| Root Directory | `.` (repo root) |
| Framework Preset | **Other** |
| Build Command | `npm run vercel-build` |
| Output Directory | **leave EMPTY** (clear `public` if set) |
| Install Command | `npm install` |

### Fix: "No Output Directory named public"

1. Project → **Settings** → **General** → **Build & Development Settings**
2. Override **Output Directory** → clear it (do not use `public`)
3. Override **Build Command** → `npm run vercel-build`
4. Framework Preset → **Other**
5. Redeploy

## Environment variables

| Name | Value |
|------|--------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon URL (`sslmode=require`, prefer pooler) |
| `JWT_SECRET` | 16+ random characters |
| `CLIENT_ORIGIN` | UI URL (after UI deploy) |
| `HOST` | `0.0.0.0` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | `llama3` |
| `COOKIE_NAME` | `herdos_token` |

## Test

`https://YOUR-API.vercel.app/api/health` → `{ "ok": true, ... }`
