import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';
import { HttpError } from '../../utils/httpError.js';

export const feedRouter = Router();
feedRouter.use(requireAuth, requireFarm);

feedRouter.get(
  '/',
  requireAccess('animals_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const types = await query(
      `SELECT t.*, COALESCE(i.quantity, 0) AS quantity, COALESCE(i.reorder_level, 50) AS reorder_level
       FROM feed_types t
       LEFT JOIN feed_inventory i ON i.feed_type_id = t.id
       WHERE t.farm_id = $1
       ORDER BY t.name`,
      [farmId],
    );
    const purchases = await query(
      `SELECT p.*, t.name AS feed_name FROM feed_purchases p
       JOIN feed_types t ON t.id = p.feed_type_id
       WHERE p.farm_id = $1 ORDER BY p.purchased_at DESC LIMIT 50`,
      [farmId],
    );
    const consumption = await query(
      `SELECT c.*, t.name AS feed_name, a.animal_code
       FROM feed_consumptions c
       JOIN feed_types t ON t.id = c.feed_type_id
       LEFT JOIN animals a ON a.id = c.animal_id
       WHERE c.farm_id = $1 ORDER BY c.consumed_at DESC LIMIT 50`,
      [farmId],
    );
    res.json({ types: types.rows, purchases: purchases.rows, consumption: consumption.rows });
  }),
);

const typeSchema = z.object({
  name: z.string().min(1).max(120),
  unit: z.string().max(20).default('kg'),
  unitCost: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().default(50),
});

feedRouter.post(
  '/types',
  requireAccess('feed_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = typeSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO feed_types (farm_id, name, unit, unit_cost) VALUES ($1,$2,$3,$4) RETURNING *`,
      [farmId, body.name, body.unit, body.unitCost],
    );
    await query(
      `INSERT INTO feed_inventory (farm_id, feed_type_id, quantity, reorder_level) VALUES ($1,$2,0,$3)`,
      [farmId, inserted.rows[0].id, body.reorderLevel],
    );
    res.status(201).json({ item: inserted.rows[0] });
  }),
);

const purchaseSchema = z.object({
  feedTypeId: z.string().uuid(),
  purchasedAt: z.string(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  supplier: z.string().max(160).optional().nullable(),
});

feedRouter.post(
  '/purchases',
  requireAccess('feed_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = purchaseSchema.parse(req.body);
    await query('BEGIN');
    try {
      const inserted = await query(
        `INSERT INTO feed_purchases (farm_id, feed_type_id, purchased_at, quantity, unit_cost, supplier, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [farmId, body.feedTypeId, body.purchasedAt, body.quantity, body.unitCost, body.supplier ?? null, req.auth?.userId],
      );
      await query(
        `INSERT INTO feed_inventory (farm_id, feed_type_id, quantity)
         VALUES ($1,$2,$3)
         ON CONFLICT (farm_id, feed_type_id)
         DO UPDATE SET quantity = feed_inventory.quantity + EXCLUDED.quantity, updated_at = now()`,
        [farmId, body.feedTypeId, body.quantity],
      );
      const total = body.quantity * body.unitCost;
      await query(
        `INSERT INTO finance_entries (farm_id, entry_type, category, amount, entry_date, description, created_by)
         VALUES ($1,'expense','feed',$2,$3,$4,$5)`,
        [farmId, total, body.purchasedAt, `Feed purchase ${body.quantity}`, req.auth?.userId],
      );
      await query('COMMIT');
      await writeAudit(req, 'feed.purchase', 'feed_purchase', inserted.rows[0].id as string, String(total));
      res.status(201).json({ item: inserted.rows[0] });
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  }),
);

const consumeSchema = z.object({
  feedTypeId: z.string().uuid(),
  animalId: z.string().uuid().optional().nullable(),
  consumedAt: z.string(),
  quantity: z.number().positive(),
});

feedRouter.post(
  '/consumption',
  requireAccess('feed_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = consumeSchema.parse(req.body);
    const stock = await query<{ quantity: string }>(
      `SELECT quantity FROM feed_inventory WHERE farm_id = $1 AND feed_type_id = $2`,
      [farmId, body.feedTypeId],
    );
    if (!stock.rows[0] || Number(stock.rows[0].quantity) < body.quantity) {
      throw new HttpError(400, 'INSUFFICIENT_FEED', 'Not enough feed in inventory.');
    }
    await query('BEGIN');
    try {
      const inserted = await query(
        `INSERT INTO feed_consumptions (farm_id, feed_type_id, animal_id, consumed_at, quantity, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [farmId, body.feedTypeId, body.animalId ?? null, body.consumedAt, body.quantity, req.auth?.userId],
      );
      await query(
        `UPDATE feed_inventory SET quantity = quantity - $3, updated_at = now()
         WHERE farm_id = $1 AND feed_type_id = $2`,
        [farmId, body.feedTypeId, body.quantity],
      );
      await query('COMMIT');
      res.status(201).json({ item: inserted.rows[0] });
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  }),
);
