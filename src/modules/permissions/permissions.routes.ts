import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireAuth, requireRoles } from '../../middleware/auth.js';
import { ROLES } from '../auth/roles.js';
import { getPermissionMatrix, updateRolePermissions } from './permissions.service.js';

export const permissionsRouter = Router();
permissionsRouter.use(requireAuth);

permissionsRouter.get(
  '/matrix',
  requireRoles('super_admin', 'farm_owner'),
  asyncHandler(async (_req, res) => {
    const data = await getPermissionMatrix();
    res.json(data);
  }),
);

const updateSchema = z.object({
  role: z.enum(ROLES),
  permissionIds: z.array(z.string().uuid()),
});

permissionsRouter.put(
  '/matrix',
  requireRoles('super_admin', 'farm_owner'),
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    if (body.role === 'super_admin') {
      res.status(400).json({ error: { code: 'INVALID_ROLE', message: 'Super Admin permissions cannot be edited.' } });
      return;
    }
    await updateRolePermissions(body.role, body.permissionIds);
    const data = await getPermissionMatrix();
    res.json(data);
  }),
);

permissionsRouter.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const role = req.auth?.farmRole ?? req.auth?.globalRole ?? 'worker';
    const data = await getPermissionMatrix();
    const ids = data.matrix[role] ?? [];
    const perms = data.permissions.filter((p) => ids.includes(p.id));
    res.json({ role, permissions: perms });
  }),
);
