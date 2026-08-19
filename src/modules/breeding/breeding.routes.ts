import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const breedingRouter = Router();
breedingRouter.use(requireAuth, requireFarm);

const schema = z.object({
  animalId: z.string().uuid(),
  eventKind: z.enum([
    'heat',
    'artificial_insemination',
    'natural_breeding',
    'pregnancy_check',
    'calving',
    'abortion',
  ]),
  eventAt: z.string().optional(),
  sireName: z.string().max(120).optional().nullable(),
  method: z.string().max(40).optional().nullable(),
  result: z.string().max(40).optional().nullable(),
  expectedCalvingDate: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

breedingRouter.get(
  '/',
  requireAccess('animals_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const items = await query(
      `SELECT b.*, a.animal_code, a.name AS animal_name
       FROM breeding_records b
       JOIN animals a ON a.id = b.animal_id
       WHERE b.farm_id = $1
       ORDER BY b.event_at DESC
       LIMIT 300`,
      [farmId],
    );
    res.json({ items: items.rows });
  }),
);

breedingRouter.post(
  '/',
  requireAccess('breeding_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = schema.parse(req.body);
    const inserted = await query(
      `INSERT INTO breeding_records (
         farm_id, animal_id, event_kind, event_at, sire_name, method, result, expected_calving_date, notes, created_by
       ) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        farmId,
        body.animalId,
        body.eventKind,
        body.eventAt ?? null,
        body.sireName ?? null,
        body.method ?? null,
        body.result ?? null,
        body.expectedCalvingDate ?? null,
        body.notes ?? null,
        req.auth?.userId,
      ],
    );

    if (body.eventKind === 'pregnancy_check' && body.result === 'pregnant') {
      await query(`UPDATE animals SET status = 'pregnant', updated_at = now() WHERE id = $1 AND farm_id = $2`, [
        body.animalId,
        farmId,
      ]);
    }
    if (body.eventKind === 'calving') {
      await query(`UPDATE animals SET status = 'lactating', updated_at = now() WHERE id = $1 AND farm_id = $2`, [
        body.animalId,
        farmId,
      ]);
    }

    await query(
      `INSERT INTO animal_events (farm_id, animal_id, event_type, title, details, created_by)
       VALUES ($1,$2,'breeding',$3,$4::jsonb,$5)`,
      [
        farmId,
        body.animalId,
        `Breeding: ${body.eventKind}`,
        JSON.stringify(body),
        req.auth?.userId,
      ],
    );
    await writeAudit(req, 'breeding.create', 'breeding', inserted.rows[0].id as string, body.eventKind);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
