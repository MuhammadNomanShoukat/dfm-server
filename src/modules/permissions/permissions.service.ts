import { query } from '../../db/pool.js';
import type { Role } from '../auth/roles.js';
import { ACCESS } from '../auth/roles.js';

export type PermissionRow = {
  id: string;
  module: string;
  action: string;
  label: string;
};

let cache: Map<Role, Set<string>> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function permKey(module: string, action: string): string {
  return `${module}:${action}`;
}

/** Maps legacy ACCESS keys to permission keys for fallback. */
const ACCESS_TO_PERMS: Record<keyof typeof ACCESS, string[]> = {
  animals_read: ['animals:view'],
  animals_write: ['animals:view', 'animals:create', 'animals:edit', 'animals:delete'],
  milking_write: ['feeding:view', 'feeding:create'],
  breeding_write: ['breeding:view', 'breeding:create', 'breeding:edit'],
  health_write: ['health:view', 'health:create', 'health:edit'],
  feed_write: ['feeding:view', 'feeding:create', 'feeding:edit'],
  finance_write: ['finance:view', 'finance:create', 'finance:edit'],
  finance_read: ['finance:view'],
  employees_write: ['users:view', 'users:create', 'users:edit'],
  tasks_write: ['dashboard:view'],
  tasks_work: ['dashboard:view'],
  collection_write: ['feeding:view'],
  reports: ['reports:view', 'reports:export'],
  admin: ['permissions:view', 'permissions:edit', 'users:view'],
  audit: ['users:view'],
};

async function loadPermissionCache(): Promise<Map<Role, Set<string>>> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) {
    return cache;
  }

  const rows = await query<{ role: Role; module: string; action: string }>(
    `SELECT rp.role, p.module, p.action
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id`,
  );

  const map = new Map<Role, Set<string>>();
  for (const row of rows.rows) {
    const set = map.get(row.role) ?? new Set<string>();
    set.add(permKey(row.module, row.action));
    map.set(row.role, set);
  }
  cache = map;
  cacheAt = now;
  return map;
}

export function invalidatePermissionCache(): void {
  cache = null;
}

export async function roleHasPermission(role: Role, module: string, action: string): Promise<boolean> {
  if (role === 'super_admin') {
    return true;
  }
  const map = await loadPermissionCache();
  const perms = map.get(role);
  if (perms?.has(permKey(module, action))) {
    return true;
  }
  return legacyAccessFallback(role, module, action);
}

function legacyAccessFallback(role: Role, module: string, action: string): boolean {
  const key = permKey(module, action);
  for (const [accessKey, roles] of Object.entries(ACCESS)) {
    if (!roles.includes(role)) {
      continue;
    }
    const mapped = ACCESS_TO_PERMS[accessKey as keyof typeof ACCESS] ?? [];
    if (mapped.includes(key)) {
      return true;
    }
  }
  return false;
}

export async function getPermissionMatrix(): Promise<{
  permissions: PermissionRow[];
  matrix: Record<string, string[]>;
}> {
  const permissions = await query<PermissionRow>(
    `SELECT id, module, action, label FROM permissions ORDER BY module, action`,
  );
  const assignments = await query<{ role: string; permission_id: string }>(
    `SELECT role, permission_id FROM role_permissions`,
  );

  const matrix: Record<string, string[]> = {};
  for (const row of assignments.rows) {
    const list = matrix[row.role] ?? [];
    list.push(row.permission_id);
    matrix[row.role] = list;
  }

  return { permissions: permissions.rows, matrix };
}

export async function updateRolePermissions(role: Role, permissionIds: string[]): Promise<void> {
  await query(`DELETE FROM role_permissions WHERE role = $1`, [role]);
  for (const pid of permissionIds) {
    await query(
      `INSERT INTO role_permissions (role, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [role, pid],
    );
  }
  invalidatePermissionCache();
}
