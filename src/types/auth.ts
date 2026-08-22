export type Role =
  | 'super_admin'
  | 'farm_owner'
  | 'farm_manager'
  | 'veterinarian'
  | 'milk_operator'
  | 'worker'
  | 'accountant';

export type AuthContext = {
  userId: string;
  tenantId: string | null;
  email: string;
  fullName: string;
  globalRole: Role;
  farmId: string | null;
  farmRole: Role | null;
};
