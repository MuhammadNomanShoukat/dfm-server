import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const healthRouter = Router();
healthRouter.use(requireAuth, requireFarm);

const recordSchema = z.object({
  animalId: z.string().uuid(),
  recordKind: z.enum(['disease', 'treatment', 'vaccination', 'deworming', 'surgery', 'lab']),
  recordedAt: z.string().optional(),
  diagnosis: z.string().max(200).optional().nullable(),
  symptoms: z.string().max(1000).optional().nullable(),
  treatment: z.string().max(1000).optional().nullable(),
  medicine: z.string().max(200).optional().nullable(),
  followUpOn: z.string().optional().nullable(),
});

healthRouter.get(
  '/',
  requireAccess('animals_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const items = await query(
      `SELECT h.*, a.animal_code, a.name AS animal_name
       FROM health_records h
       JOIN animals a ON a.id = h.animal_id
       WHERE h.farm_id = $1
       ORDER BY h.recorded_at DESC
       LIMIT 300`,
      [farmId],
    );
    const vaccines = await query(
      `SELECT v.*, a.animal_code, a.name AS animal_name
       FROM vaccinations v
       JOIN animals a ON a.id = v.animal_id
       WHERE v.farm_id = $1
       ORDER BY v.given_on DESC
       LIMIT 200`,
      [farmId],
    );
    res.json({ items: items.rows, vaccinations: vaccines.rows });
  }),
);

healthRouter.post(
  '/',
  requireAccess('health_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = recordSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO health_records (
         farm_id, animal_id, record_kind, recorded_at, diagnosis, symptoms, treatment, medicine, vet_id, follow_up_on
       ) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        farmId,
        body.animalId,
        body.recordKind,
        body.recordedAt ?? null,
        body.diagnosis ?? null,
        body.symptoms ?? null,
        body.treatment ?? null,
        body.medicine ?? null,
        req.auth?.userId,
        body.followUpOn ?? null,
      ],
    );
    if (body.recordKind === 'disease') {
      await query(`UPDATE animals SET status = 'sick', updated_at = now() WHERE id = $1 AND farm_id = $2`, [
        body.animalId,
        farmId,
      ]);
    }
    await query(
      `INSERT INTO animal_events (farm_id, animal_id, event_type, title, details, created_by)
       VALUES ($1,$2,'health',$3,$4::jsonb,$5)`,
      [farmId, body.animalId, `Health: ${body.recordKind}`, JSON.stringify(body), req.auth?.userId],
    );
    await writeAudit(req, 'health.create', 'health_record', inserted.rows[0].id as string, body.recordKind);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);

const vaxSchema = z.object({
  animalId: z.string().uuid(),
  vaccineName: z.string().min(1).max(160),
  givenOn: z.string(),
  nextDueOn: z.string().optional().nullable(),
  batchNo: z.string().max(80).optional().nullable(),
});

healthRouter.post(
  '/vaccinations',
  requireAccess('health_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = vaxSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO vaccinations (farm_id, animal_id, vaccine_name, given_on, next_due_on, batch_no, vet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [farmId, body.animalId, body.vaccineName, body.givenOn, body.nextDueOn ?? null, body.batchNo ?? null, req.auth?.userId],
    );
    await query(
      `INSERT INTO animal_events (farm_id, animal_id, event_type, title, details, created_by)
       VALUES ($1,$2,'vaccination',$3,$4::jsonb,$5)`,
      [farmId, body.animalId, `Vaccinated: ${body.vaccineName}`, JSON.stringify(body), req.auth?.userId],
    );
    await writeAudit(req, 'vaccination.create', 'vaccination', inserted.rows[0].id as string, body.vaccineName);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
