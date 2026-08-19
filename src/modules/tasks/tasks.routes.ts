import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';
import { getIo } from '../../ws/io.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth, requireFarm);

tasksRouter.get(
  '/',
  requireAccess('tasks_work'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const mine = req.query.mine === 'true';
    const params: unknown[] = [farmId];
    let extra = '';
    if (mine) {
      params.push(req.auth?.userId);
      extra = ` AND t.assigned_to = $2`;
    }
    const items = await query(
      `SELECT t.*, u.full_name AS assignee_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.farm_id = $1 ${extra}
       ORDER BY
         CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         t.due_at NULLS LAST
       LIMIT 200`,
      params,
    );
    res.json({ items: items.rows });
  }),
);

const createSchema = z.object({
  title: z.string().min(2).max(200),
  taskKind: z.enum(['feeding', 'cleaning', 'health', 'maintenance', 'other']),
  description: z.string().max(1000).optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
  dueAt: z.string().optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});

tasksRouter.post(
  '/',
  requireAccess('tasks_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = createSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO tasks (farm_id, title, task_kind, description, assigned_to, due_at, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        farmId,
        body.title,
        body.taskKind,
        body.description ?? null,
        body.assignedTo ?? null,
        body.dueAt ?? null,
        body.priority,
        req.auth?.userId,
      ],
    );
    if (body.assignedTo) {
      await query(
        `INSERT INTO notifications (farm_id, user_id, title, body, severity)
         VALUES ($1,$2,'Task assigned',$3,'info')`,
        [farmId, body.assignedTo, body.title],
      );
    }
    await writeAudit(req, 'task.create', 'task', inserted.rows[0].id as string, body.title);
    getIo()?.to(`farm:${farmId}`).emit('dashboard:invalidate');
    res.status(201).json({ item: inserted.rows[0] });
  }),
);

const statusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']),
});

tasksRouter.patch(
  '/:id',
  requireAccess('tasks_work'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = statusSchema.parse(req.body);
    const updated = await query(
      `UPDATE tasks SET status = $3, updated_at = now(),
         escalated = CASE WHEN due_at < now() AND $3 NOT IN ('done','cancelled') THEN true ELSE escalated END
       WHERE id = $1 AND farm_id = $2
       RETURNING *`,
      [req.params.id, farmId, body.status],
    );
    res.json({ item: updated.rows[0] });
  }),
);
