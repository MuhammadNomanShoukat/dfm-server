export const ROLES = [
  'super_admin',
  'farm_owner',
  'farm_manager',
  'veterinarian',
  'milk_operator',
  'worker',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  farm_owner: 'Farm Owner',
  farm_manager: 'Farm Manager',
  veterinarian: 'Veterinarian',
  milk_operator: 'Milk Collection Operator',
  worker: 'Worker',
};

const WRITE_ROLES: Role[] = ['super_admin', 'farm_owner', 'farm_manager'];

export const ACCESS: Record<string, Role[]> = {
  animals_write: [...WRITE_ROLES],
  animals_read: ['super_admin', 'farm_owner', 'farm_manager', 'veterinarian', 'milk_operator', 'worker'],
  milking_write: ['super_admin', 'farm_owner', 'farm_manager', 'milk_operator'],
  breeding_write: [...WRITE_ROLES, 'veterinarian'],
  health_write: ['super_admin', 'farm_owner', 'farm_manager', 'veterinarian'],
  feed_write: [...WRITE_ROLES],
  finance_write: ['super_admin', 'farm_owner'],
  finance_read: ['super_admin', 'farm_owner', 'farm_manager'],
  employees_write: ['super_admin', 'farm_owner'],
  tasks_write: [...WRITE_ROLES],
  tasks_work: ['super_admin', 'farm_owner', 'farm_manager', 'worker', 'veterinarian', 'milk_operator'],
  collection_write: ['super_admin', 'farm_owner', 'farm_manager', 'milk_operator'],
  reports: ['super_admin', 'farm_owner', 'farm_manager'],
  admin: ['super_admin'],
  audit: ['super_admin', 'farm_owner'],
};
