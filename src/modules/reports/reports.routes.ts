import { Router } from 'express';
import ExcelJS from 'exceljs';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAccess, requireAuth, requireFarm, requireFarmId } from '../../middleware/auth.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireFarm, requireAccess('reports'));

reportsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const animals = await query(`SELECT status, COUNT(*)::int AS n FROM animals WHERE farm_id = $1 AND deleted_at IS NULL GROUP BY status`, [farmId]);
    const milk = await query(
      `SELECT to_char(date_trunc('month', recorded_at), 'YYYY-MM') AS month, SUM(quantity_liters)::float AS liters
       FROM milk_records WHERE farm_id = $1
       GROUP BY 1 ORDER BY 1`,
      [farmId],
    );
    const health = await query(
      `SELECT record_kind, COUNT(*)::int AS n FROM health_records WHERE farm_id = $1 GROUP BY record_kind`,
      [farmId],
    );
    res.json({ animals: animals.rows, milk: milk.rows, health: health.rows });
  }),
);

reportsRouter.get(
  '/export/:kind',
  asyncHandler(async (req, res) => {
    const farmId = requireFarmId(req);
    const kind = req.params.kind;
    const format = typeof req.query.format === 'string' ? req.query.format : 'csv';

    const tables: Record<string, string> = {
      animals: `SELECT animal_code, name, breed, gender, status, rfid_tag FROM animals WHERE farm_id = $1 AND deleted_at IS NULL ORDER BY animal_code`,
      milk: `SELECT recorded_at, shift, quantity_liters, fat_pct, snf_pct FROM milk_records WHERE farm_id = $1 ORDER BY recorded_at DESC`,
      finance: `SELECT entry_date, entry_type, category, amount, description FROM finance_entries WHERE farm_id = $1 ORDER BY entry_date DESC`,
      health: `SELECT recorded_at, record_kind, diagnosis, treatment FROM health_records WHERE farm_id = $1 ORDER BY recorded_at DESC`,
      employees: `SELECT employee_code, full_name, role_title, salary, shift FROM employees WHERE farm_id = $1 ORDER BY full_name`,
      inventory: `SELECT t.name, i.quantity, t.unit, t.unit_cost FROM feed_inventory i JOIN feed_types t ON t.id = i.feed_type_id WHERE i.farm_id = $1`,
    };
    const sql = tables[kind];
    if (!sql) {
      res.status(404).json({ error: { code: 'UNKNOWN_REPORT', message: 'Unknown report kind.' } });
      return;
    }
    const result = await query(sql, [farmId]);
    const rows = result.rows as Record<string, unknown>[];
    const headers = rows[0] ? Object.keys(rows[0]) : ['empty'];

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet(kind);
      sheet.addRow(headers);
      for (const row of rows) {
        sheet.addRow(headers.map((h) => row[h]));
      }
      const buf = await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}.xlsx"`);
      res.send(Buffer.from(buf));
      return;
    }

    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
    res.send(csv);
  }),
);

function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}
