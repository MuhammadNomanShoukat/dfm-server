-- HerdOS enhancements: weight history, permissions, plans, workflow

ALTER TABLE animals ADD COLUMN IF NOT EXISTS target_weight_kg NUMERIC(8, 2);

CREATE TABLE IF NOT EXISTS animal_weight_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_id UUID NOT NULL REFERENCES animals(id),
  weight_kg NUMERIC(8, 2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS animal_weight_animal_idx ON animal_weight_records (animal_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module VARCHAR(60) NOT NULL,
  action VARCHAR(20) NOT NULL,
  label VARCHAR(120) NOT NULL,
  UNIQUE (module, action),
  CONSTRAINT perm_action_chk CHECK (action IN ('view', 'create', 'edit', 'delete', 'export', 'approve'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role VARCHAR(40) NOT NULL,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_id)
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  description TEXT,
  price_monthly NUMERIC(10, 2) NOT NULL DEFAULT 0,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS workflow_completions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  workflow_key VARCHAR(80) NOT NULL,
  completed_on DATE NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (user_id, farm_id, workflow_key, completed_on)
);

CREATE TABLE IF NOT EXISTS sync_idempotency (
  client_id VARCHAR(120) PRIMARY KEY,
  farm_id UUID NOT NULL REFERENCES farms(id),
  entity_type VARCHAR(60) NOT NULL,
  server_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allow accountant role
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_global_role_chk;
ALTER TABLE users ADD CONSTRAINT users_global_role_chk CHECK (global_role IN (
  'super_admin', 'farm_owner', 'farm_manager', 'veterinarian', 'milk_operator', 'worker', 'accountant'
));

ALTER TABLE user_farm_roles DROP CONSTRAINT IF EXISTS ufr_role_chk;
ALTER TABLE user_farm_roles ADD CONSTRAINT ufr_role_chk CHECK (role IN (
  'super_admin', 'farm_owner', 'farm_manager', 'veterinarian', 'milk_operator', 'worker', 'accountant'
));

INSERT INTO subscription_plans (id, name, description, price_monthly, limits, features, sort_order)
VALUES
  ('free', 'Free', 'Small farms — basic dashboard and reports', 0,
   '{"maxAnimals":25,"maxUsers":1,"maxFarms":1,"aiReports":false,"offlineSync":false,"export":false}'::jsonb,
   '["basic_dashboard","basic_reports"]'::jsonb, 0),
  ('starter', 'Starter', 'Growing small farms', 2500,
   '{"maxAnimals":100,"maxUsers":5,"maxFarms":1,"aiReports":false,"offlineSync":false,"export":true}'::jsonb,
   '["animal_profiles","health","feeding","breeding","finance"]'::jsonb, 1),
  ('professional', 'Professional', 'Growing farms with AI and offline', 7500,
   '{"maxAnimals":500,"maxUsers":20,"maxFarms":3,"aiReports":true,"offlineSync":true,"export":true}'::jsonb,
   '["ai_reports","advanced_analytics","multi_role","offline_sync","export"]'::jsonb, 2),
  ('enterprise', 'Enterprise', 'Large organizations', 0,
   '{"maxAnimals":99999,"maxUsers":999,"maxFarms":99,"aiReports":true,"offlineSync":true,"export":true,"apiAccess":true}'::jsonb,
   '["unlimited","api_access","priority_support","advanced_permissions"]'::jsonb, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (module, action, label) VALUES
  ('dashboard', 'view', 'View dashboard'),
  ('animals', 'view', 'View animals'),
  ('animals', 'create', 'Create animals'),
  ('animals', 'edit', 'Edit animals'),
  ('animals', 'delete', 'Delete animals'),
  ('animals', 'export', 'Export animals'),
  ('health', 'view', 'View health'),
  ('health', 'create', 'Create health records'),
  ('health', 'edit', 'Edit health records'),
  ('health', 'delete', 'Delete health records'),
  ('feeding', 'view', 'View feeding'),
  ('feeding', 'create', 'Create feeding records'),
  ('feeding', 'edit', 'Edit feeding records'),
  ('breeding', 'view', 'View breeding'),
  ('breeding', 'create', 'Create breeding records'),
  ('breeding', 'edit', 'Edit breeding records'),
  ('finance', 'view', 'View finance'),
  ('finance', 'create', 'Create finance entries'),
  ('finance', 'edit', 'Edit finance entries'),
  ('finance', 'export', 'Export finance'),
  ('finance', 'approve', 'Approve finance'),
  ('reports', 'view', 'View reports'),
  ('reports', 'export', 'Export reports'),
  ('ai_reports', 'view', 'View AI reports'),
  ('users', 'view', 'View users'),
  ('users', 'create', 'Create users'),
  ('users', 'edit', 'Edit users'),
  ('users', 'delete', 'Delete users'),
  ('permissions', 'view', 'View permissions'),
  ('permissions', 'edit', 'Edit permissions'),
  ('subscription', 'view', 'View subscription'),
  ('subscription', 'edit', 'Edit subscription')
ON CONFLICT (module, action) DO NOTHING;

-- Seed role_permissions (super_admin gets all via middleware bypass)
INSERT INTO role_permissions (role, permission_id)
SELECT 'farm_owner', p.id FROM permissions p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
SELECT 'farm_manager', p.id FROM permissions p
WHERE p.module NOT IN ('users', 'permissions', 'subscription')
  AND p.action IN ('view', 'create', 'edit', 'export')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
SELECT 'veterinarian', p.id FROM permissions p
WHERE p.module IN ('dashboard', 'animals', 'health', 'breeding', 'reports')
  AND p.action IN ('view', 'create', 'edit')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
SELECT 'accountant', p.id FROM permissions p
WHERE p.module IN ('dashboard', 'finance', 'reports')
  AND p.action IN ('view', 'export', 'approve')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
SELECT 'worker', p.id FROM permissions p
WHERE p.module IN ('dashboard', 'animals', 'feeding', 'tasks')
  AND p.action = 'view'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
SELECT 'milk_operator', p.id FROM permissions p
WHERE p.module IN ('dashboard', 'animals', 'feeding')
  AND p.action IN ('view', 'create')
ON CONFLICT DO NOTHING;

-- Demo: set target weights for existing animals
UPDATE animals SET target_weight_kg = COALESCE(weight_kg, 400) + 30
WHERE target_weight_kg IS NULL AND deleted_at IS NULL AND status NOT IN ('sold', 'dead');

UPDATE animals SET weight_kg = GREATEST(weight_kg - 45, 200)
WHERE status IN ('sick', 'heifer') AND target_weight_kg IS NOT NULL AND weight_kg IS NOT NULL;
