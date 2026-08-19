import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAccess, requireAuth, requireAuthContext, requireFarm } from '../../middleware/auth.js';
import { writeAudit } from '../../middleware/audit.js';
import { HttpError } from '../../utils/httpError.js';

export const farmsRouter = Router();
farmsRouter.use(requireAuth);

farmsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = requireAuthContext(req);
    const result =
      auth.globalRole === 'super_admin'
        ? await query(
            `SELECT f.*, t.name AS tenant_name
             FROM farms f JOIN tenants t ON t.id = f.tenant_id
             ORDER BY f.name`,
          )
        : await query(
            `SELECT f.*, t.name AS tenant_name
             FROM farms f
             JOIN tenants t ON t.id = f.tenant_id
             JOIN user_farm_roles ufr ON ufr.farm_id = f.id
             WHERE ufr.user_id = $1
             ORDER BY f.name`,
            [auth.userId],
          );
    res.json({ items: result.rows });
  }),
);

farmsRouter.get(
  '/:id/barns',
  requireFarm,
  asyncHandler(async (req, res) => {
    const farmId = req.auth?.farmId;
    const barns = await query(
      `SELECT b.*, COALESCE(json_agg(json_build_object('id', s.id, 'code', s.code) ORDER BY s.code)
        FILTER (WHERE s.id IS NOT NULL), '[]') AS stalls
       FROM barns b
       LEFT JOIN stalls s ON s.barn_id = b.id
       WHERE b.farm_id = $1
       GROUP BY b.id
       ORDER BY b.name`,
      [farmId],
    );
    res.json({ items: barns.rows });
  }),
);

const farmSchema = z.object({
  name: z.string().min(2).max(200),
  code: z.string().min(2).max(40),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(80).optional(),
  areaAcres: z.number().nonnegative().optional(),
});

farmsRouter.post(
  '/',
  requireAccess('admin'),
  asyncHandler(async (req, res) => {
    const body = farmSchema.parse(req.body);
    const tenant = await query<{ id: string }>(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`);
    if (!tenant.rows[0]) {
      throw new HttpError(400, 'NO_TENANT', 'Create a tenant first.');
    }
    const inserted = await query(
      `INSERT INTO farms (tenant_id, name, code, address, city, country, area_acres)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        tenant.rows[0].id,
        body.name,
        body.code.toUpperCase(),
        body.address ?? null,
        body.city ?? null,
        body.country ?? 'Pakistan',
        body.areaAcres ?? null,
      ],
    );
    await writeAudit(req, 'farm.create', 'farm', inserted.rows[0].id as string, body.name);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
