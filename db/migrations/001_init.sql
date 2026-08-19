-- HerdOS initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  subscription_plan VARCHAR(50) NOT NULL DEFAULT 'free',
  subscription_status VARCHAR(30) NOT NULL DEFAULT 'active',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  phone VARCHAR(40),
  global_role VARCHAR(40) NOT NULL DEFAULT 'worker',
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  mfa_secret VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_global_role_chk CHECK (global_role IN (
    'super_admin', 'farm_owner', 'farm_manager', 'veterinarian', 'milk_operator', 'worker'
  ))
);

CREATE TABLE farms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(200) NOT NULL,
  code VARCHAR(40) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  country VARCHAR(80) NOT NULL DEFAULT 'Pakistan',
  latitude NUMERIC(10, 7),
  longitude NUMERIC(10, 7),
  area_acres NUMERIC(10, 2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE user_farm_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  role VARCHAR(40) NOT NULL,
  PRIMARY KEY (user_id, farm_id),
  CONSTRAINT ufr_role_chk CHECK (role IN (
    'super_admin', 'farm_owner', 'farm_manager', 'veterinarian', 'milk_operator', 'worker'
  ))
);

CREATE TABLE barns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(40) NOT NULL DEFAULT 'shed',
  capacity INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stalls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barn_id UUID NOT NULL REFERENCES barns(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (barn_id, code)
);

CREATE TABLE animals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_code VARCHAR(40) NOT NULL,
  rfid_tag VARCHAR(80),
  qr_code VARCHAR(120) NOT NULL,
  name VARCHAR(120),
  breed VARCHAR(80) NOT NULL,
  species VARCHAR(40) NOT NULL DEFAULT 'cattle',
  gender VARCHAR(20) NOT NULL,
  birth_date DATE,
  weight_kg NUMERIC(8, 2),
  color VARCHAR(60),
  status VARCHAR(30) NOT NULL DEFAULT 'lactating',
  barn_id UUID REFERENCES barns(id),
  stall_id UUID REFERENCES stalls(id),
  image_url TEXT,
  sire_id UUID REFERENCES animals(id),
  dam_id UUID REFERENCES animals(id),
  purchase_price NUMERIC(14, 2),
  purchase_date DATE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, animal_code),
  CONSTRAINT animals_gender_chk CHECK (gender IN ('female', 'male')),
  CONSTRAINT animals_status_chk CHECK (status IN (
    'calf', 'heifer', 'bull', 'lactating', 'dry', 'pregnant', 'sick', 'sold', 'dead'
  ))
);

CREATE INDEX animals_farm_idx ON animals (farm_id) WHERE deleted_at IS NULL;
CREATE INDEX animals_status_idx ON animals (farm_id, status) WHERE deleted_at IS NULL;

CREATE TABLE animal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_id UUID NOT NULL REFERENCES animals(id),
  event_type VARCHAR(40) NOT NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  title VARCHAR(200) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX animal_events_animal_idx ON animal_events (animal_id, event_at DESC);

CREATE TABLE breeding_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_id UUID NOT NULL REFERENCES animals(id),
  event_kind VARCHAR(40) NOT NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sire_name VARCHAR(120),
  method VARCHAR(40),
  result VARCHAR(40),
  expected_calving_date DATE,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT breeding_kind_chk CHECK (event_kind IN (
    'heat', 'artificial_insemination', 'natural_breeding', 'pregnancy_check', 'calving', 'abortion'
  ))
);

CREATE TABLE milk_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_id UUID NOT NULL REFERENCES animals(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  shift VARCHAR(20) NOT NULL,
  quantity_liters NUMERIC(10, 2) NOT NULL,
  fat_pct NUMERIC(5, 2),
  protein_pct NUMERIC(5, 2),
  snf_pct NUMERIC(5, 2),
  temperature_c NUMERIC(5, 2),
  operator_id UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT milk_shift_chk CHECK (shift IN ('morning', 'evening', 'night')),
  CONSTRAINT milk_qty_chk CHECK (quantity_liters >= 0)
);

CREATE INDEX milk_farm_date_idx ON milk_records (farm_id, recorded_at DESC);
CREATE INDEX milk_animal_idx ON milk_records (animal_id, recorded_at DESC);

CREATE TABLE farmers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  code VARCHAR(40) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  phone VARCHAR(40),
  village VARCHAR(120),
  rate_per_liter NUMERIC(10, 2) NOT NULL DEFAULT 80,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, code)
);

CREATE TABLE collection_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  name VARCHAR(120) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE milk_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  farmer_id UUID NOT NULL REFERENCES farmers(id),
  route_id UUID REFERENCES collection_routes(id),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  quantity_liters NUMERIC(10, 2) NOT NULL,
  fat_pct NUMERIC(5, 2),
  snf_pct NUMERIC(5, 2),
  water_pct NUMERIC(5, 2),
  density NUMERIC(8, 4),
  temperature_c NUMERIC(5, 2),
  amount_due NUMERIC(14, 2),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feed_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'kg',
  unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feed_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  feed_type_id UUID NOT NULL REFERENCES feed_types(id),
  quantity NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(12, 2) NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, feed_type_id)
);

CREATE TABLE feed_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  feed_type_id UUID NOT NULL REFERENCES feed_types(id),
  purchased_at DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity NUMERIC(12, 2) NOT NULL,
  unit_cost NUMERIC(12, 2) NOT NULL,
  supplier VARCHAR(160),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feed_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  feed_type_id UUID NOT NULL REFERENCES feed_types(id),
  animal_id UUID REFERENCES animals(id),
  consumed_at DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity NUMERIC(12, 2) NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE health_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_id UUID NOT NULL REFERENCES animals(id),
  record_kind VARCHAR(40) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  diagnosis VARCHAR(200),
  symptoms TEXT,
  treatment TEXT,
  medicine VARCHAR(200),
  vet_id UUID REFERENCES users(id),
  follow_up_on DATE,
  attachment_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT health_kind_chk CHECK (record_kind IN (
    'disease', 'treatment', 'vaccination', 'deworming', 'surgery', 'lab'
  ))
);

CREATE TABLE vaccinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  animal_id UUID NOT NULL REFERENCES animals(id),
  vaccine_name VARCHAR(160) NOT NULL,
  given_on DATE NOT NULL,
  next_due_on DATE,
  batch_no VARCHAR(80),
  vet_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE finance_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  entry_type VARCHAR(20) NOT NULL,
  category VARCHAR(60) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finance_type_chk CHECK (entry_type IN ('income', 'expense')),
  CONSTRAINT finance_amount_chk CHECK (amount >= 0)
);

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  user_id UUID REFERENCES users(id),
  employee_code VARCHAR(40) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  role_title VARCHAR(80),
  phone VARCHAR(40),
  hire_date DATE,
  salary NUMERIC(14, 2),
  shift VARCHAR(20) DEFAULT 'morning',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, employee_code)
);

CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  work_date DATE NOT NULL,
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  overtime_hours NUMERIC(6, 2) NOT NULL DEFAULT 0,
  UNIQUE (employee_id, work_date)
);

CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  title VARCHAR(200) NOT NULL,
  task_kind VARCHAR(40) NOT NULL,
  description TEXT,
  assigned_to UUID REFERENCES users(id),
  due_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  escalated BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_kind_chk CHECK (task_kind IN ('feeding', 'cleaning', 'health', 'maintenance', 'other')),
  CONSTRAINT task_status_chk CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  CONSTRAINT task_priority_chk CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID REFERENCES farms(id),
  user_id UUID REFERENCES users(id),
  channel VARCHAR(20) NOT NULL DEFAULT 'in_app',
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  farm_id UUID REFERENCES farms(id),
  actor_id UUID REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  summary TEXT,
  ip_address VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE TABLE dashboard_layouts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  widgets JSONB NOT NULL,
  PRIMARY KEY (user_id, farm_id)
);

CREATE TABLE ai_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id),
  alert_type VARCHAR(60) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning',
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_open BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE system_settings (
  key VARCHAR(80) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value)
VALUES ('app', '{"name":"HerdOS","mfaRequiredForSuperAdmin":false}'::jsonb);
