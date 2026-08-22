import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';
import { requirePlanFeature } from '../subscription/subscription.service.js';
import { HttpError } from '../../utils/httpError.js';

export const syncRouter = Router();
syncRouter.use(requireAuth, requireFarm, requirePlanFeature('offlineSync'));

const opSchema = z.object({
  clientId: z.string().min(8).max(120),
  entityType: z.enum(['animal', 'task', 'milk_record', 'health_record', 'finance_entry']),
  action: z.enum(['create', 'update']),
  payload: z.record(z.unknown()),
  updatedAt: z.string(),
});

const pushSchema = z.object({
  operations: z.array(opSchema).max(50),
});

syncRouter.post(
  '/push',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = pushSchema.parse(req.body);
    const results: { clientId: string; status: 'synced' | 'duplicate' | 'failed'; serverId?: string; error?: string }[] =
      [];

    for (const op of body.operations) {
      const existing = await query<{ server_id: string | null }>(
        `SELECT server_id FROM sync_idempotency WHERE client_id = $1`,
        [op.clientId],
      );
      if (existing.rows[0]) {
        results.push({
          clientId: op.clientId,
          status: 'duplicate',
          serverId: existing.rows[0].server_id ?? undefined,
        });
        continue;
      }

      try {
        const serverId = await applySyncOperation(farmId, req.auth!.userId, op);
        await query(
          `INSERT INTO sync_idempotency (client_id, farm_id, entity_type, server_id)
           VALUES ($1, $2, $3, $4)`,
          [op.clientId, farmId, op.entityType, serverId],
        );
        results.push({ clientId: op.clientId, status: 'synced', serverId });
      } catch (error) {
        results.push({
          clientId: op.clientId,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Sync failed',
        });
      }
    }

    await writeAudit(req, 'sync.push', 'sync', farmId, `${results.filter((r) => r.status === 'synced').length} ops`);
    res.json({ results });
  }),
);

syncRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, serverTime: new Date().toISOString() });
  }),
);

type SyncOp = z.infer<typeof opSchema>;

async function applySyncOperation(farmId: string, userId: string, op: SyncOp): Promise<string> {
  switch (op.entityType) {
    case 'animal':
      return syncAnimal(farmId, userId, op);
    case 'task':
      return syncTask(farmId, userId, op);
    case 'milk_record':
      return syncMilk(farmId, userId, op);
    case 'finance_entry':
      return syncFinance(farmId, userId, op);
    case 'health_record':
      return syncHealth(farmId, userId, op);
    default:
      throw new HttpError(400, 'UNSUPPORTED', 'Unsupported entity type.');
  }
}

async function syncAnimal(farmId: string, userId: string, op: SyncOp): Promise<string> {
  const p = op.payload as Record<string, unknown>;
  if (op.action === 'update' && typeof p.id === 'string') {
    await query(
      `UPDATE animals SET name = COALESCE($4, name), weight_kg = COALESCE($5, weight_kg), status = COALESCE($6, status), updated_at = now()
       WHERE id = $1 AND farm_id = $2 AND deleted_at IS NULL`,
      [p.id, farmId, userId, p.name ?? null, p.weightKg ?? null, p.status ?? null],
    );
    return p.id;
  }
  const code = String(p.animalCode ?? p.animal_code ?? 'OFFLINE');
  const inserted = await query<{ id: string }>(
    `INSERT INTO animals (farm_id, animal_code, qr_code, name, breed, species, gender, status, weight_kg)
     VALUES ($1, $2, $3, $4, $5, 'cattle', $6, $7, $8)
     RETURNING id`,
    [
      farmId,
      code.toUpperCase(),
      `HERD:${farmId.slice(0, 8)}:${code.toUpperCase()}`,
      p.name ?? null,
      p.breed ?? 'Unknown',
      p.gender ?? 'female',
      p.status ?? 'lactating',
      p.weightKg ?? null,
    ],
  );
  return inserted.rows[0].id;
}

async function syncTask(farmId: string, userId: string, op: SyncOp): Promise<string> {
  const p = op.payload as Record<string, unknown>;
  const inserted = await query<{ id: string }>(
    `INSERT INTO tasks (farm_id, title, task_kind, description, status, priority, created_by)
     VALUES ($1, $2, $3, $4, $5, 'normal', $6) RETURNING id`,
    [farmId, p.title ?? 'Offline task', p.taskKind ?? 'other', p.description ?? null, p.status ?? 'open', userId],
  );
  return inserted.rows[0].id;
}

async function syncMilk(farmId: string, userId: string, op: SyncOp): Promise<string> {
  const p = op.payload as Record<string, unknown>;
  const inserted = await query<{ id: string }>(
    `INSERT INTO milk_records (farm_id, animal_id, shift, quantity_liters, operator_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [farmId, p.animalId, p.shift ?? 'morning', p.quantityLiters ?? 0, userId],
  );
  return inserted.rows[0].id;
}

async function syncFinance(farmId: string, userId: string, op: SyncOp): Promise<string> {
  const p = op.payload as Record<string, unknown>;
  const inserted = await query<{ id: string }>(
    `INSERT INTO finance_entries (farm_id, entry_type, category, amount, entry_date, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      farmId,
      p.entryType ?? 'expense',
      p.category ?? 'other',
      p.amount ?? 0,
      p.entryDate ?? new Date().toISOString().slice(0, 10),
      p.description ?? 'Offline entry',
      userId,
    ],
  );
  return inserted.rows[0].id;
}

async function syncHealth(farmId: string, _userId: string, op: SyncOp): Promise<string> {
  const p = op.payload as Record<string, unknown>;
  const inserted = await query<{ id: string }>(
    `INSERT INTO health_records (farm_id, animal_id, record_kind, diagnosis, treatment)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [farmId, p.animalId, p.recordKind ?? 'treatment', p.diagnosis ?? null, p.treatment ?? null],
  );
  return inserted.rows[0].id;
}
