import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';
import { HttpError } from '../../utils/httpError.js';

export const animalsRouter = Router();
animalsRouter.use(requireAuth, requireFarm);

const animalSchema = z.object({
  animalCode: z.string().min(1).max(40),
  rfidTag: z.string().max(80).optional().nullable(),
  name: z.string().max(120).optional().nullable(),
  breed: z.string().min(1).max(80),
  species: z.string().max(40).default('cattle'),
  gender: z.enum(['female', 'male']),
  birthDate: z.string().optional().nullable(),
  weightKg: z.number().positive().optional().nullable(),
  color: z.string().max(60).optional().nullable(),
  status: z.enum(['calf', 'heifer', 'bull', 'lactating', 'dry', 'pregnant', 'sick', 'sold', 'dead']),
  barnId: z.string().uuid().optional().nullable(),
  stallId: z.string().uuid().optional().nullable(),
  sireId: z.string().uuid().optional().nullable(),
  damId: z.string().uuid().optional().nullable(),
});

animalsRouter.get(
  '/',
  requireAccess('animals_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [farmId];
    const filters = ['a.farm_id = $1', 'a.deleted_at IS NULL'];
    if (status) {
      params.push(status);
      filters.push(`a.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      filters.push(
        `(a.animal_code ILIKE $${params.length} OR COALESCE(a.name,'') ILIKE $${params.length} OR COALESCE(a.rfid_tag,'') ILIKE $${params.length})`,
      );
    }
    const where = filters.join(' AND ');
    const count = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM animals a WHERE ${where}`, params);
    params.push(pageSize, offset);
    const items = await query(
      `SELECT a.*, b.name AS barn_name, s.code AS stall_code
       FROM animals a
       LEFT JOIN barns b ON b.id = a.barn_id
       LEFT JOIN stalls s ON s.id = a.stall_id
       WHERE ${where}
       ORDER BY a.animal_code
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ items: items.rows, total: Number(count.rows[0].count), page, pageSize });
  }),
);

animalsRouter.get(
  '/:id',
  requireAccess('animals_read'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const item = await getAnimal(farmId, req.params.id);
    const timeline = await query(
      `SELECT * FROM animal_events WHERE farm_id = $1 AND animal_id = $2 ORDER BY event_at DESC LIMIT 100`,
      [farmId, req.params.id],
    );
    res.json({ item, timeline: timeline.rows });
  }),
);

animalsRouter.post(
  '/',
  requireAccess('animals_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = animalSchema.parse(req.body);
    const qr = `HERD:${farmId.slice(0, 8)}:${body.animalCode.toUpperCase()}`;
    const inserted = await query(
      `INSERT INTO animals (
         farm_id, animal_code, rfid_tag, qr_code, name, breed, species, gender,
         birth_date, weight_kg, color, status, barn_id, stall_id, sire_id, dam_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        farmId,
        body.animalCode.toUpperCase(),
        body.rfidTag || null,
        qr,
        body.name || null,
        body.breed,
        body.species,
        body.gender,
        body.birthDate || null,
        body.weightKg ?? null,
        body.color || null,
        body.status,
        body.barnId || null,
        body.stallId || null,
        body.sireId || null,
        body.damId || null,
      ],
    );
    const animal = inserted.rows[0];
    await addEvent(farmId, animal.id as string, 'created', 'Animal registered', req.auth?.userId ?? null, {});
    await writeAudit(req, 'animal.create', 'animal', animal.id as string, body.animalCode);
    res.status(201).json({ item: animal });
  }),
);

animalsRouter.patch(
  '/:id',
  requireAccess('animals_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = animalSchema.partial().parse(req.body);
    await getAnimal(farmId, req.params.id);
    const updated = await query(
      `UPDATE animals SET
         animal_code = COALESCE($3, animal_code),
         rfid_tag = COALESCE($4, rfid_tag),
         name = COALESCE($5, name),
         breed = COALESCE($6, breed),
         species = COALESCE($7, species),
         gender = COALESCE($8, gender),
         birth_date = COALESCE($9, birth_date),
         weight_kg = COALESCE($10, weight_kg),
         color = COALESCE($11, color),
         status = COALESCE($12, status),
         barn_id = COALESCE($13, barn_id),
         stall_id = COALESCE($14, stall_id),
         updated_at = now()
       WHERE id = $1 AND farm_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        req.params.id,
        farmId,
        body.animalCode?.toUpperCase() ?? null,
        body.rfidTag ?? null,
        body.name ?? null,
        body.breed ?? null,
        body.species ?? null,
        body.gender ?? null,
        body.birthDate ?? null,
        body.weightKg ?? null,
        body.color ?? null,
        body.status ?? null,
        body.barnId ?? null,
        body.stallId ?? null,
      ],
    );
    await writeAudit(req, 'animal.update', 'animal', req.params.id, 'Updated animal');
    res.json({ item: updated.rows[0] });
  }),
);

animalsRouter.delete(
  '/:id',
  requireAccess('animals_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    await getAnimal(farmId, req.params.id);
    await query(
      `UPDATE animals SET deleted_at = now(), updated_at = now() WHERE id = $1 AND farm_id = $2`,
      [req.params.id, farmId],
    );
    await writeAudit(req, 'animal.delete', 'animal', req.params.id, 'Soft-deleted animal');
    res.json({ ok: true });
  }),
);

const transferSchema = z.object({
  barnId: z.string().uuid().nullable().optional(),
  stallId: z.string().uuid().nullable().optional(),
  notes: z.string().max(500).optional(),
});

animalsRouter.post(
  '/:id/transfer',
  requireAccess('animals_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = transferSchema.parse(req.body);
    await getAnimal(farmId, req.params.id);
    await query(
      `UPDATE animals SET barn_id = $3, stall_id = $4, updated_at = now() WHERE id = $1 AND farm_id = $2`,
      [req.params.id, farmId, body.barnId ?? null, body.stallId ?? null],
    );
    await addEvent(farmId, req.params.id, 'transfer', 'Transferred stall', req.auth?.userId ?? null, body);
    await writeAudit(req, 'animal.transfer', 'animal', req.params.id, 'Transfer');
    res.json({ ok: true });
  }),
);

const saleSchema = z.object({
  amount: z.number().nonnegative(),
  buyer: z.string().max(160).optional(),
  soldOn: z.string(),
});

animalsRouter.post(
  '/:id/sell',
  requireAccess('animals_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = saleSchema.parse(req.body);
    await getAnimal(farmId, req.params.id);
    await query(`BEGIN`);
    try {
      await query(
        `UPDATE animals SET status = 'sold', deleted_at = NULL, updated_at = now() WHERE id = $1 AND farm_id = $2`,
        [req.params.id, farmId],
      );
      await query(
        `INSERT INTO finance_entries (farm_id, entry_type, category, amount, entry_date, description, created_by)
         VALUES ($1,'income','animal_sales',$2,$3,$4,$5)`,
        [farmId, body.amount, body.soldOn, `Sale of animal ${req.params.id} to ${body.buyer ?? 'buyer'}`, req.auth?.userId],
      );
      await addEvent(farmId, req.params.id, 'sale', 'Animal sold', req.auth?.userId ?? null, body);
      await query(`COMMIT`);
    } catch (error) {
      await query(`ROLLBACK`);
      throw error;
    }
    await writeAudit(req, 'animal.sell', 'animal', req.params.id, 'Sold');
    res.json({ ok: true });
  }),
);

const deathSchema = z.object({ cause: z.string().max(300), diedOn: z.string() });

animalsRouter.post(
  '/:id/death',
  requireAccess('animals_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = deathSchema.parse(req.body);
    await getAnimal(farmId, req.params.id);
    await query(
      `UPDATE animals SET status = 'dead', updated_at = now() WHERE id = $1 AND farm_id = $2`,
      [req.params.id, farmId],
    );
    await addEvent(farmId, req.params.id, 'death', body.cause, req.auth?.userId ?? null, body);
    await writeAudit(req, 'animal.death', 'animal', req.params.id, body.cause);
    res.json({ ok: true });
  }),
);

async function getAnimal(farmId: string, id: string) {
  const result = await query(
    `SELECT a.*, b.name AS barn_name, s.code AS stall_code
     FROM animals a
     LEFT JOIN barns b ON b.id = a.barn_id
     LEFT JOIN stalls s ON s.id = a.stall_id
     WHERE a.id = $1 AND a.farm_id = $2 AND a.deleted_at IS NULL`,
    [id, farmId],
  );
  if (!result.rows[0]) {
    throw new HttpError(404, 'ANIMAL_NOT_FOUND', 'Animal not found on this farm.');
  }
  return result.rows[0];
}

async function addEvent(
  farmId: string,
  animalId: string,
  eventType: string,
  title: string,
  createdBy: string | null,
  details: unknown,
): Promise<void> {
  await query(
    `INSERT INTO animal_events (farm_id, animal_id, event_type, title, details, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [farmId, animalId, eventType, title, JSON.stringify(details), createdBy],
  );
}
