import type { NextFunction, Request, Response } from 'express';
import { roleHasPermission } from '../modules/permissions/permissions.service.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import type { Role } from '../modules/auth/roles.js';
import { ACCESS } from '../modules/auth/roles.js';
import { HttpError } from '../utils/httpError.js';
import type { AuthContext } from '../types/auth.js';

type JwtPayload = {
  sub: string;
  kind: 'session' | 'mfa';
};

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId, kind: 'session' } satisfies JwtPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function signMfa(userId: string): string {
  return jwt.sign({ sub: userId, kind: 'mfa' } satisfies JwtPayload, env.JWT_SECRET, {
    expiresIn: env.MFA_TOKEN_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function setSessionCookie(res: Response, token: string): void {
  const crossSite = env.NODE_ENV === 'production';
  res.cookie(env.COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  const crossSite = env.NODE_ENV === 'production';
  res.clearCookie(env.COOKIE_NAME, {
    path: '/',
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[env.COOKIE_NAME] as string | undefined;
  if (!token) {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Session expired. Please sign in again.'));
    return;
  }

  if (payload.kind !== 'session') {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Invalid session.'));
    return;
  }

  void loadAuth(req, payload.sub).then(() => next()).catch(next);
}

async function loadAuth(req: Request, userId: string): Promise<void> {
  const result = await query<{
    id: string;
    tenant_id: string | null;
    email: string;
    full_name: string;
    global_role: Role;
    is_active: boolean;
  }>(
    `SELECT id, tenant_id, email, full_name, global_role, is_active
     FROM users WHERE id = $1`,
    [userId],
  );
  const user = result.rows[0];
  if (!user || !user.is_active) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Account is not active.');
  }

  const auth: AuthContext = {
    userId: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    fullName: user.full_name,
    globalRole: user.global_role,
    farmId: null,
    farmRole: user.global_role === 'super_admin' ? 'super_admin' : null,
  };

  const farmHeader = req.header('x-farm-id');
  if (farmHeader) {
    if (user.global_role === 'super_admin') {
      const farm = await query(`SELECT id FROM farms WHERE id = $1`, [farmHeader]);
      if (!farm.rows[0]) {
        throw new HttpError(404, 'FARM_NOT_FOUND', 'Farm not found.');
      }
      auth.farmId = farmHeader;
      auth.farmRole = 'super_admin';
    } else {
      const membership = await query<{ role: Role }>(
        `SELECT role FROM user_farm_roles WHERE user_id = $1 AND farm_id = $2`,
        [user.id, farmHeader],
      );
      if (!membership.rows[0]) {
        throw new HttpError(403, 'FARM_FORBIDDEN', 'You do not have access to this farm.');
      }
      auth.farmId = farmHeader;
      auth.farmRole = membership.rows[0].role;
    }
  }

  req.auth = auth;
}

export function requireFarm(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth?.farmId) {
    next(new HttpError(400, 'FARM_REQUIRED', 'Select a farm first.'));
    return;
  }
  next();
}

export function requireRoles(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.auth?.farmRole ?? req.auth?.globalRole;
    if (!role || (!allowed.includes(role) && role !== 'super_admin')) {
      next(new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action.'));
      return;
    }
    if (role === 'super_admin') {
      next();
      return;
    }
    next();
  };
}

export function requireAccess(key: keyof typeof ACCESS) {
  return requireRoles(...ACCESS[key]);
}

export function requireAuthContext(req: Request): AuthContext {
  if (!req.auth) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  }
  return req.auth;
}

export function requireFarmId(req: Request): string {
  const auth = requireAuthContext(req);
  if (!auth.farmId) {
    throw new HttpError(400, 'FARM_REQUIRED', 'Select a farm first.');
  }
  return auth.farmId;
}

export function requirePermission(module: string, action: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const role = req.auth?.farmRole ?? req.auth?.globalRole;
      if (!role) {
        next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
        return;
      }
      const allowed = await roleHasPermission(role, module, action);
      if (!allowed) {
        next(new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action.'));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function verifyMfaToken(token: string): string {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    if (payload.kind !== 'mfa') {
      throw new Error('not mfa');
    }
    return payload.sub;
  } catch {
    throw new HttpError(401, 'MFA_EXPIRED', 'MFA challenge expired. Sign in again.');
  }
}
