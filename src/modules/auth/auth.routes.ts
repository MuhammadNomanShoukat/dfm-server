import { Router } from 'express';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { HttpError } from '../../utils/httpError.js';
import {
  clearSessionCookie,
  requireAuth,
  requireAuthContext,
  setSessionCookie,
  signMfa,
  signSession,
  verifyMfaToken,
} from '../../middleware/auth.js';
import { writeAudit } from '../../middleware/audit.js';
import type { Role } from './roles.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const result = await query<{
      id: string;
      password_hash: string;
      is_active: boolean;
      mfa_enabled: boolean;
      full_name: string;
      global_role: Role;
    }>(
      `SELECT id, password_hash, is_active, mfa_enabled, full_name, global_role
       FROM users WHERE email = $1`,
      [email],
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    if (user.mfa_enabled) {
      res.json({
        mfaRequired: true,
        mfaToken: signMfa(user.id),
        fullName: user.full_name,
      });
      return;
    }

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    setSessionCookie(res, signSession(user.id));
    req.auth = {
      userId: user.id,
      tenantId: null,
      email,
      fullName: user.full_name,
      globalRole: user.global_role,
      farmId: null,
      farmRole: user.global_role === 'super_admin' ? 'super_admin' : null,
    };
    await writeAudit(req, 'auth.login', 'user', user.id, 'Signed in');
    const session = await loadSession(user.id);
    res.json({ mfaRequired: false, user: session });
  }),
);

const mfaSchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/),
});

authRouter.post(
  '/mfa/verify',
  asyncHandler(async (req, res) => {
    const body = mfaSchema.parse(req.body);
    const userId = verifyMfaToken(body.mfaToken);
    const result = await query<{ mfa_secret: string | null; is_active: boolean }>(
      `SELECT mfa_secret, is_active FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user?.is_active || !user.mfa_secret) {
      throw new HttpError(401, 'MFA_INVALID', 'MFA is not configured.');
    }
    const valid = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token: body.code,
      window: 1,
    });
    if (!valid) {
      throw new HttpError(401, 'MFA_INVALID', 'That code is not valid.');
    }
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
    setSessionCookie(res, signSession(userId));
    res.json({ user: await loadSession(userId) });
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    clearSessionCookie(res);
    await writeAudit(req, 'auth.logout', 'user', req.auth?.userId ?? null, 'Signed out');
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ user: await loadSession(auth.userId) });
  }),
);

authRouter.post(
  '/mfa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = requireAuthContext(req);
    const secret = speakeasy.generateSecret({
      name: `HerdOS (${auth.email})`,
      length: 20,
    });
    await query(`UPDATE users SET mfa_secret = $1, updated_at = now() WHERE id = $2`, [
      secret.base32,
      auth.userId,
    ]);
    const otpauth = secret.otpauth_url ?? '';
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ otpauth, qrDataUrl });
  }),
);

const enableMfaSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

authRouter.post(
  '/mfa/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = requireAuthContext(req);
    const { code } = enableMfaSchema.parse(req.body);
    const result = await query<{ mfa_secret: string | null }>(
      `SELECT mfa_secret FROM users WHERE id = $1`,
      [auth.userId],
    );
    const secret = result.rows[0]?.mfa_secret;
    if (!secret) {
      throw new HttpError(400, 'MFA_NOT_SETUP', 'Generate an MFA secret first.');
    }
    const valid = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
    if (!valid) {
      throw new HttpError(400, 'MFA_INVALID', 'That code is not valid.');
    }
    await query(`UPDATE users SET mfa_enabled = true, updated_at = now() WHERE id = $1`, [auth.userId]);
    await writeAudit(req, 'auth.mfa_enable', 'user', auth.userId, 'Enabled MFA');
    res.json({ ok: true });
  }),
);

async function loadSession(userId: string) {
  const userRes = await query<{
    id: string;
    email: string;
    full_name: string;
    global_role: Role;
    tenant_id: string | null;
    mfa_enabled: boolean;
    phone: string | null;
  }>(
    `SELECT id, email, full_name, global_role, tenant_id, mfa_enabled, phone
     FROM users WHERE id = $1`,
    [userId],
  );
  const user = userRes.rows[0];
  if (!user) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  }

  const farmsRes = await query<{
    id: string;
    name: string;
    code: string;
    city: string | null;
    role: Role;
  }>(
    user.global_role === 'super_admin'
      ? `SELECT f.id, f.name, f.code, f.city, 'super_admin'::varchar AS role
         FROM farms f WHERE f.is_active = true ORDER BY f.name`
      : `SELECT f.id, f.name, f.code, f.city, ufr.role
         FROM user_farm_roles ufr
         JOIN farms f ON f.id = ufr.farm_id
         WHERE ufr.user_id = $1 AND f.is_active = true
         ORDER BY f.name`,
    user.global_role === 'super_admin' ? [] : [userId],
  );

  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    phone: user.phone,
    globalRole: user.global_role,
    tenantId: user.tenant_id,
    mfaEnabled: user.mfa_enabled,
    farms: farmsRes.rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      city: row.city,
      role: row.role,
    })),
  };
}
