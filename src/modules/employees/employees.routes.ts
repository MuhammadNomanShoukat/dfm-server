import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { writeAudit } from '../../middleware/audit.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const employeesRouter = Router();
employeesRouter.use(requireAuth, requireFarm);

employeesRouter.get(
  '/',
  requireAccess('employees_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const items = await query(`SELECT * FROM employees WHERE farm_id = $1 ORDER BY full_name`, [farmId]);
    const attendance = await query(
      `SELECT a.*, e.full_name FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.farm_id = $1 AND a.work_date >= CURRENT_DATE - 14
       ORDER BY a.work_date DESC`,
      [farmId],
    );
    const leaves = await query(
      `SELECT l.*, e.full_name FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       WHERE l.farm_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
      [farmId],
    );
    res.json({ items: items.rows, attendance: attendance.rows, leaves: leaves.rows });
  }),
);

const empSchema = z.object({
  employeeCode: z.string().min(1).max(40),
  fullName: z.string().min(1).max(200),
  roleTitle: z.string().max(80).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  hireDate: z.string().optional().nullable(),
  salary: z.number().nonnegative().optional().nullable(),
  shift: z.enum(['morning', 'evening', 'night']).optional(),
});

employeesRouter.post(
  '/',
  requireAccess('employees_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = empSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO employees (farm_id, employee_code, full_name, role_title, phone, hire_date, salary, shift)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        farmId,
        body.employeeCode.toUpperCase(),
        body.fullName,
        body.roleTitle ?? null,
        body.phone ?? null,
        body.hireDate ?? null,
        body.salary ?? null,
        body.shift ?? 'morning',
      ],
    );
    await writeAudit(req, 'employee.create', 'employee', inserted.rows[0].id as string, body.fullName);
    res.status(201).json({ item: inserted.rows[0] });
  }),
);

const attSchema = z.object({
  employeeId: z.string().uuid(),
  workDate: z.string(),
  checkIn: z.string().optional().nullable(),
  checkOut: z.string().optional().nullable(),
  overtimeHours: z.number().nonnegative().default(0),
});

employeesRouter.post(
  '/attendance',
  requireAccess('employees_write'),
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const body = attSchema.parse(req.body);
    const inserted = await query(
      `INSERT INTO attendance (farm_id, employee_id, work_date, check_in, check_out, source, overtime_hours)
       VALUES ($1,$2,$3,$4,$5,'manual',$6)
       ON CONFLICT (employee_id, work_date) DO UPDATE
         SET check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, overtime_hours = EXCLUDED.overtime_hours
       RETURNING *`,
      [farmId, body.employeeId, body.workDate, body.checkIn ?? null, body.checkOut ?? null, body.overtimeHours],
    );
    res.status(201).json({ item: inserted.rows[0] });
  }),
);
