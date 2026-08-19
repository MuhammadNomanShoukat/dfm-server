import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const collectionRouter = Router();
collectionRouter.use(requireAuth, requireFarm);

collectionRouter.get(
  '/',
  requireAccess('collection_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const farmers = await query(`SELECT * FROM farmers WHERE farm_id = $1 ORDER BY full_name`, [farmId]);
    const routes = await query(`SELECT * FROM collection_routes WHERE farm_id = $1 ORDER BY name`, [farmId]);
    const collections = await query(
      `SELECT c.*, f.full_name AS farmer_name, r.name AS route_name
       FROM milk_collections c
       JOIN farmers f ON f.id = c.farmer_id
       LEFT JOIN collection_routes r ON r.id = c.route_id
       WHERE c.farm_id = $1
       ORDER BY c.collected_at DESC
       LIMIT 200`,
      [farmId],
    );
    const payments = await query<{ farmer_id: string; farmer_name: string; liters: string; due: string }>(
      `SELECT f.id AS farmer_id, f.full_name AS farmer_name,
              COALESCE(SUM(c.quantity_liters),0)::text AS liters,
              COALESCE(SUM(c.amount_due),0)::text AS due
       FROM farmers f
       LEFT JOIN milk_collections c ON c.farmer_id = f.id AND c.collected_at >= date_trunc('month', CURRENT_DATE)
       WHERE f.farm_id = $1
       GROUP BY f.id, f.full_name
       ORDER BY f.full_name`,
      [farmId],
    );
    res.json({
      farmers: farmers.rows,
      routes: routes.rows,
      collections: collections.rows,
      paymentSheet: payments.rows,
    });
  }),
);

const farmerSchema = z.object({
  code: z.string().min(1).max(40),
  fullName: z.string().min(1).max(200),
  phone: z.string().max(40).optional().nullable(),
  village: z.string().max(120).optional().nullable(),
  ratePerLiter: z.number().nonnegative().default(80),
});

collectionRouter.post(
  '/farmers',
  requireAccess('collection_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = farmerSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO farmers (farm_id, code, full_name, phone, village, rate_per_liter)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [farmId, body.code.toUpperCase(), body.fullName, body.phone ?? null, body.village ?? null, body.ratePerLiter],
    );
    res.status(201).json({ item: inserted.rows[0] });
  }),
);

const collectSchema = z.object({
  farmerId: z.string().uuid(),
  routeId: z.string().uuid().optional().nullable(),
  collectedAt: z.string().optional(),
  quantityLiters: z.number().positive(),
  fatPct: z.number().min(0).max(20).optional().nullable(),
  snfPct: z.number().min(0).max(20).optional().nullable(),
  waterPct: z.number().min(0).max(20).optional().nullable(),
  density: z.number().positive().optional().nullable(),
  temperatureC: z.number().min(0).max(50).optional().nullable(),
});

collectionRouter.post(
  '/intake',
  requireAccess('collection_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = collectSchema.parse(req.body);
    const farmer = await query<{ rate_per_liter: string }>(
      `SELECT rate_per_liter FROM farmers WHERE id = $1 AND farm_id = $2`,
      [body.farmerId, farmId],
    );
    const rate = Number(farmer.rows[0]?.rate_per_liter ?? 80);
    const due = Math.round(rate * body.quantityLiters * 100) / 100;
    const inserted = await query(
      `INSERT INTO milk_collections (
         farm_id, farmer_id, route_id, collected_at, quantity_liters, fat_pct, snf_pct, water_pct, density, temperature_c, amount_due, created_by
       ) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        farmId,
        body.farmerId,
        body.routeId ?? null,
        body.collectedAt ?? null,
        body.quantityLiters,
        body.fatPct ?? null,
        body.snfPct ?? null,
        body.waterPct ?? null,
        body.density ?? null,
        body.temperatureC ?? null,
        due,
        req.auth?.userId,
      ],
    );
    await writeAudit(req, 'collection.intake', 'milk_collection', inserted.rows[0].id as string, `${body.quantityLiters} L`);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
