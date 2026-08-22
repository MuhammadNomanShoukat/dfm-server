import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAccess, requireAuth, requireRoles } from '../../middleware/auth.js';
import { getTenantPlan, getUsage, listPlans } from './subscription.service.js';

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth);

subscriptionRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await listPlans();
    res.json({ items: plans });
  }),
);

subscriptionRouter.get(
  '/current',
  asyncHandler(async (req, res) => {
    const tenantId = req.auth?.tenantId ?? null;
    const { planId, plan } = await getTenantPlan(tenantId);
    const usage = await getUsage(tenantId);
    let status = 'active';
    if (tenantId) {
      const row = await query<{ subscription_status: string }>(
        `SELECT subscription_status FROM tenants WHERE id = $1`,
        [tenantId],
      );
      status = row.rows[0]?.subscription_status ?? 'active';
    }
    res.json({ planId, plan, usage, status });
  }),
);

const upgradeSchema = z.object({
  planId: z.enum(['free', 'starter', 'professional', 'enterprise']),
});

subscriptionRouter.patch(
  '/plan',
  requireRoles('super_admin', 'farm_owner'),
  asyncHandler(async (req, res) => {
    const body = upgradeSchema.parse(req.body);
    const tenantId = req.auth?.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: { code: 'NO_TENANT', message: 'No tenant associated with this account.' } });
      return;
    }
    await query(`UPDATE tenants SET subscription_plan = $2, updated_at = now() WHERE id = $1`, [
      tenantId,
      body.planId,
    ]);
    const { planId, plan } = await getTenantPlan(tenantId);
    const usage = await getUsage(tenantId);
    res.json({ planId, plan, usage });
  }),
);

subscriptionRouter.get(
  '/admin/tenants',
  requireAccess('admin'),
  asyncHandler(async (_req, res) => {
    const items = await query(
      `SELECT id, name, slug, subscription_plan, subscription_status, created_at FROM tenants ORDER BY name`,
    );
    res.json({ items: items.rows });
  }),
);
