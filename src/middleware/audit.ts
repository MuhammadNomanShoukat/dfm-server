import type { Request } from 'express';
import { query } from '../db/pool.js';

export async function writeAudit(
  req: Request,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
): Promise<void> {
  const auth = req.auth;
  await query(
    `INSERT INTO audit_logs (tenant_id, farm_id, actor_id, action, entity_type, entity_id, summary, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      auth?.tenantId ?? null,
      auth?.farmId ?? null,
      auth?.userId ?? null,
      action,
      entityType,
      entityId,
      summary,
      req.ip ?? null,
    ],
  );
}
