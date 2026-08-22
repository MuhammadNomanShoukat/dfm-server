import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireFarm, requireFarmId, requireRoles } from '../../middleware/auth.js';
import { loadActionDashboard } from './dashboard.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireFarm);

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const userId = req.auth!.userId;
    const data = await loadActionDashboard(farmId, userId);
    res.json(data);
  }),
);

const workflowSchema = z.object({
  workflowKey: z.string().min(1).max(80),
  completed: z.boolean(),
});

dashboardRouter.post(
  '/workflow',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const userId = req.auth!.userId;
    const body = workflowSchema.parse(req.body);

    if (body.completed) {
      await query(
        `INSERT INTO workflow_completions (user_id, farm_id, workflow_key, completed_on)
         VALUES ($1, $2, $3, CURRENT_DATE)
         ON CONFLICT DO NOTHING`,
        [userId, farmId, body.workflowKey],
      );
    } else {
      await query(
        `DELETE FROM workflow_completions
         WHERE user_id = $1 AND farm_id = $2 AND workflow_key = $3 AND completed_on = CURRENT_DATE`,
        [userId, farmId, body.workflowKey],
      );
    }
    res.json({ ok: true });
  }),
);

/** Legacy layout endpoint kept for compatibility */
dashboardRouter.put(
  '/layout',
  requireRoles('farm_owner', 'farm_manager', 'super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ widgets: [] });
  }),
);
