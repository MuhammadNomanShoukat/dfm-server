import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAccess, requireAuth } from '../../middleware/auth.js';
import { writeAudit } from '../../middleware/audit.js';
import { ROLES } from '../auth/roles.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAccess('admin'));

adminRouter.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const users = await query(
      `SELECT id, email, full_name, phone, global_role, is_active, mfa_enabled, last_login_at, created_at
       FROM users ORDER BY created_at`,
    );
    res.json({ items: users.rows });
  }),
);

const userSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(200),
  password: z.string().min(10).max(128),
  globalRole: z.enum(ROLES),
  farmId: z.string().uuid().optional(),
  phone: z.string().max(40).optional(),
});

adminRouter.post(
  '/users',
  asyncHandler(async (req, res) => {
    const body = userSchema.parse(req.body);
    const hash = await bcrypt.hash(body.password, 10);
    const tenant = await query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
    const inserted = await query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, phone, global_role)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name, global_role`,
      [tenant.rows[0]?.id ?? null, body.email.toLowerCase(), hash, body.fullName, body.phone ?? null, body.globalRole],
    );
    if (body.farmId) {
      await query(
        `INSERT INTO user_farm_roles (user_id, farm_id, role) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [inserted.rows[0].id, body.farmId, body.globalRole],
      );
    }
    await writeAudit(req, 'admin.user_create', 'user', inserted.rows[0].id as string, body.email);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);

adminRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const rows = await query(`SELECT key, value FROM system_settings`);
    res.json({ items: rows.rows });
  }),
);

adminRouter.get(
  '/audit',
  asyncHandler(async (_req, res) => {
    const items = await query(
      `SELECT a.*, u.email AS actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC
       LIMIT 200`,
    );
    res.json({ items: items.rows });
  }),
);
