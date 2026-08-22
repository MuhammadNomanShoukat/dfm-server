import { query } from '../../db/pool.js';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../utils/httpError.js';
import type { Role } from '../auth/roles.js';
import { roleHasPermission } from '../permissions/permissions.service.js';

export type PlanLimits = {
  maxAnimals: number;
  maxUsers: number;
  maxFarms: number;
  aiReports: boolean;
  offlineSync: boolean;
  export: boolean;
  apiAccess?: boolean;
};

export type PlanInfo = {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  limits: PlanLimits;
  features: string[];
};

const DEFAULT_LIMITS: PlanLimits = {
  maxAnimals: 25,
  maxUsers: 1,
  maxFarms: 1,
  aiReports: false,
  offlineSync: false,
  export: false,
};

export async function getTenantPlan(tenantId: string | null): Promise<{ planId: string; plan: PlanInfo }> {
  if (!tenantId) {
    return { planId: 'free', plan: await getPlanById('free') };
  }
  const tenant = await query<{ subscription_plan: string }>(
    `SELECT subscription_plan FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const planId = tenant.rows[0]?.subscription_plan ?? 'free';
  const plan = await getPlanById(planId);
  return { planId, plan };
}

export async function getPlanById(planId: string): Promise<PlanInfo> {
  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    price_monthly: string;
    limits: PlanLimits;
    features: string[];
  }>(`SELECT id, name, description, price_monthly::text, limits, features FROM subscription_plans WHERE id = $1`, [
    planId,
  ]);

  const row = result.rows[0];
  if (!row) {
    return {
      id: 'free',
      name: 'Free',
      description: 'Default plan',
      priceMonthly: 0,
      limits: DEFAULT_LIMITS,
      features: ['basic_dashboard'],
    };
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceMonthly: Number(row.price_monthly),
    limits: { ...DEFAULT_LIMITS, ...row.limits },
    features: row.features ?? [],
  };
}

export async function listPlans(): Promise<PlanInfo[]> {
  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    price_monthly: string;
    limits: PlanLimits;
    features: string[];
  }>(`SELECT id, name, description, price_monthly::text, limits, features
      FROM subscription_plans WHERE is_active = true ORDER BY sort_order`);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    priceMonthly: Number(row.price_monthly),
    limits: { ...DEFAULT_LIMITS, ...row.limits },
    features: row.features ?? [],
  }));
}

export async function checkAnimalLimit(tenantId: string | null, farmId: string): Promise<void> {
  const { plan } = await getTenantPlan(tenantId);
  const count = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM animals WHERE farm_id = $1 AND deleted_at IS NULL AND status NOT IN ('sold','dead')`,
    [farmId],
  );
  if (Number(count.rows[0].n) >= plan.limits.maxAnimals) {
    throw new HttpError(
      403,
      'PLAN_LIMIT',
      `Your ${plan.name} plan allows up to ${plan.limits.maxAnimals} animals. Upgrade to add more.`,
    );
  }
}

export function requirePlanFeature(feature: keyof PlanLimits) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const { plan } = await getTenantPlan(req.auth?.tenantId ?? null);
      const value = plan.limits[feature];
      if (typeof value === 'boolean' && !value) {
        next(new HttpError(403, 'PLAN_FEATURE', `This feature requires a higher subscription plan.`));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function getUsage(tenantId: string | null): Promise<{
  animals: number;
  users: number;
  farms: number;
}> {
  if (!tenantId) {
    return { animals: 0, users: 0, farms: 0 };
  }
  const [animals, users, farms] = await Promise.all([
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM animals a
       JOIN farms f ON f.id = a.farm_id
       WHERE f.tenant_id = $1 AND a.deleted_at IS NULL AND a.status NOT IN ('sold','dead')`,
      [tenantId],
    ),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM users WHERE tenant_id = $1 AND is_active = true`, [
      tenantId,
    ]),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM farms WHERE tenant_id = $1 AND is_active = true`, [
      tenantId,
    ]),
  ]);
  return {
    animals: Number(animals.rows[0].n),
    users: Number(users.rows[0].n),
    farms: Number(farms.rows[0].n),
  };
}

export async function roleCanExport(role: Role, tenantId: string | null): Promise<boolean> {
  const { plan } = await getTenantPlan(tenantId);
  if (!plan.limits.export) {
    return false;
  }
  return roleHasPermission(role, 'reports', 'export');
}
