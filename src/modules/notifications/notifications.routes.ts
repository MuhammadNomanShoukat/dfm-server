import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth, requireFarm);

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const items = await query(
      `SELECT * FROM notifications
       WHERE farm_id = $1 AND (user_id IS NULL OR user_id = $2)
       ORDER BY created_at DESC
       LIMIT 50`,
      [farmId, req.auth?.userId],
    );
    res.json({ items: items.rows });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    await query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND farm_id = $2`,
      [req.params.id, farmId],
    );
    res.json({ ok: true });
  }),
);
