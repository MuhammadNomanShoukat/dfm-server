import type pg from 'pg';
import bcrypt from 'bcryptjs';

type Client = pg.Client;

const USERS = [
  { email: 'superadmin@herdos.local', password: 'HerdOS@Admin1', name: 'Sana Super', role: 'super_admin' },
  { email: 'owner@herdos.local', password: 'HerdOS@Owner1', name: 'Omar Malik', role: 'farm_owner' },
  { email: 'manager@herdos.local', password: 'HerdOS@Manager1', name: 'Nadia Manager', role: 'farm_manager' },
  { email: 'vet@herdos.local', password: 'HerdOS@Vet1', name: 'Dr. Imran Vet', role: 'veterinarian' },
  { email: 'milk@herdos.local', password: 'HerdOS@Milk1', name: 'Ali Milk Op', role: 'milk_operator' },
  { email: 'worker@herdos.local', password: 'HerdOS@Worker1', name: 'Rashid Worker', role: 'worker' },
] as const;

export async function seed(db: Client): Promise<void> {
  const existing = await db.query('SELECT COUNT(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) {
    process.stdout.write('Seed skipped (users already exist)\n');
    return;
  }

  const tenant = await db.query(
    `INSERT INTO tenants (name, slug, subscription_plan) VALUES ('Green Pasture Co-op', 'green-pasture', 'free') RETURNING id`,
  );
  const tenantId = tenant.rows[0].id as string;

  const userIds: Record<string, string> = {};
  for (const user of USERS) {
    const hash = await bcrypt.hash(user.password, 10);
    const row = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, global_role, phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, user.email, hash, user.name, user.role, '0300-0000000'],
    );
    userIds[user.role] = row.rows[0].id as string;
  }

  const farm1 = await insertFarm(db, tenantId, 'Green Valley Dairy', 'GV01', 'Kasur');
  const farm2 = await insertFarm(db, tenantId, 'Canal View Farm', 'CV02', 'Okara');

  for (const farmId of [farm1, farm2]) {
    for (const role of ['farm_owner', 'farm_manager', 'veterinarian', 'milk_operator', 'worker'] as const) {
      await db.query(`INSERT INTO user_farm_roles (user_id, farm_id, role) VALUES ($1,$2,$3)`, [
        userIds[role],
        farmId,
        role,
      ]);
    }
  }

  await seedFarm(db, farm1, userIds, 0);
  await seedFarm(db, farm2, userIds, 1);
  process.stdout.write('Seeded demo farms, herd, milk, and finance.\n');
}

async function insertFarm(db: Client, tenantId: string, name: string, code: string, city: string): Promise<string> {
  const row = await db.query(
    `INSERT INTO farms (tenant_id, name, code, city, country, area_acres, address)
     VALUES ($1,$2,$3,$4,'Pakistan', 42, $5) RETURNING id`,
    [tenantId, name, code, city, `${name}, ${city}`],
  );
  return row.rows[0].id as string;
}

async function seedFarm(
  db: Client,
  farmId: string,
  userIds: Record<string, string>,
  offset: number,
): Promise<void> {
  const barnA = await db.query(`INSERT INTO barns (farm_id, name, kind, capacity) VALUES ($1,'Barn A','shed',40) RETURNING id`, [farmId]);
  const barnB = await db.query(`INSERT INTO barns (farm_id, name, kind, capacity) VALUES ($1,'Dry Lot','yard',20) RETURNING id`, [farmId]);
  const barnAId = barnA.rows[0].id as string;
  const barnBId = barnB.rows[0].id as string;
  const stall1 = await db.query(`INSERT INTO stalls (barn_id, code) VALUES ($1,'S-01') RETURNING id`, [barnAId]);
  const stall2 = await db.query(`INSERT INTO stalls (barn_id, code) VALUES ($1,'S-02') RETURNING id`, [barnAId]);

  const statuses = ['lactating', 'lactating', 'lactating', 'lactating', 'dry', 'pregnant', 'sick', 'heifer'] as const;
  const breeds = ['Sahiwal', 'Holstein', 'Jersey', 'Cholistani', 'Sahiwal', 'Holstein', 'Jersey', 'Sahiwal'];
  const animalIds: string[] = [];

  for (let i = 0; i < 8; i += 1) {
    const code = `GV-${String(100 + offset * 20 + i)}`;
    const row = await db.query(
      `INSERT INTO animals (
         farm_id, animal_code, rfid_tag, qr_code, name, breed, species, gender, birth_date, weight_kg, color, status, barn_id, stall_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'cattle','female',$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        farmId,
        code,
        `RFID-${code}`,
        `HERD:${code}`,
        ['Laila', 'Noor', 'Sundari', 'Moti', 'Chameli', 'Gulab', 'Rani', 'Heera'][i],
        breeds[i],
        `2019-0${(i % 8) + 1}-12`,
        380 + i * 12,
        i % 2 === 0 ? 'Red dun' : 'Black & white',
        statuses[i],
        statuses[i] === 'dry' ? barnBId : barnAId,
        i < 2 ? stall1.rows[0].id : stall2.rows[0].id,
      ],
    );
    animalIds.push(row.rows[0].id as string);
  }

  const lactating = animalIds.filter((_, i) => statuses[i] === 'lactating');
  const today = new Date();
  for (let d = 20; d >= 0; d -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    const iso = day.toISOString().slice(0, 10);
    for (const [idx, animalId] of lactating.entries()) {
      const morning = 8.2 + ((idx + offset + d) % 5) * 0.6;
      const evening = 6.4 + ((idx + d) % 4) * 0.5;
      await db.query(
        `INSERT INTO milk_records (farm_id, animal_id, recorded_at, shift, quantity_liters, fat_pct, protein_pct, snf_pct, temperature_c, operator_id)
         VALUES ($1,$2,$3::date + time '05:30',$4,$5,4.1,3.3,8.6,36.4,$6)`,
        [farmId, animalId, iso, 'morning', morning, userIds.milk_operator],
      );
      await db.query(
        `INSERT INTO milk_records (farm_id, animal_id, recorded_at, shift, quantity_liters, fat_pct, protein_pct, snf_pct, temperature_c, operator_id)
         VALUES ($1,$2,$3::date + time '17:15',$4,$5,4.0,3.2,8.5,36.6,$6)`,
        [farmId, animalId, iso, 'evening', evening, userIds.milk_operator],
      );
    }
  }

  await db.query(
    `INSERT INTO breeding_records (farm_id, animal_id, event_kind, method, result, expected_calving_date, notes, created_by)
     VALUES ($1,$2,'pregnancy_check','ultrasound','pregnant', CURRENT_DATE + 12, 'Confirmed 5 months', $3)`,
    [farmId, animalIds[5], userIds.veterinarian],
  );
  await db.query(
    `INSERT INTO breeding_records (farm_id, animal_id, event_kind, method, notes, created_by)
     VALUES ($1,$2,'heat','observation','Standing heat morning', $3)`,
    [farmId, animalIds[0], userIds.farm_manager],
  );

  await db.query(
    `INSERT INTO health_records (farm_id, animal_id, record_kind, diagnosis, symptoms, treatment, vet_id)
     VALUES ($1,$2,'disease','Mastitis suspected','Warm udder, flakes in milk','Strip + antibiotic per vet', $3)`,
    [farmId, animalIds[6], userIds.veterinarian],
  );
  await db.query(
    `INSERT INTO vaccinations (farm_id, animal_id, vaccine_name, given_on, next_due_on, vet_id)
     VALUES ($1,$2,'FMD', CURRENT_DATE - 80, CURRENT_DATE + 5, $3)`,
    [farmId, animalIds[0], userIds.veterinarian],
  );

  const silage = await db.query(
    `INSERT INTO feed_types (farm_id, name, unit, unit_cost) VALUES ($1,'Corn silage','kg',18) RETURNING id`,
    [farmId],
  );
  const conc = await db.query(
    `INSERT INTO feed_types (farm_id, name, unit, unit_cost) VALUES ($1,'Concentrate mix','kg',52) RETURNING id`,
    [farmId],
  );
  await db.query(
    `INSERT INTO feed_inventory (farm_id, feed_type_id, quantity, reorder_level) VALUES ($1,$2,1200,200), ($1,$3,80,100)`,
    [farmId, silage.rows[0].id, conc.rows[0].id],
  );
  await db.query(
    `INSERT INTO feed_consumptions (farm_id, feed_type_id, consumed_at, quantity, created_by)
     VALUES ($1,$2,CURRENT_DATE, 90, $3)`,
    [farmId, silage.rows[0].id, userIds.worker],
  );

  await db.query(
    `INSERT INTO finance_entries (farm_id, entry_type, category, amount, entry_date, description, created_by) VALUES
     ($1,'income','milk_sales', 185000, CURRENT_DATE - 2, 'Bulk milk to processor', $2),
     ($1,'income','subsidies', 25000, CURRENT_DATE - 10, 'Livestock support', $2),
     ($1,'expense','feed', 64000, CURRENT_DATE - 4, 'Silage + concentrate', $2),
     ($1,'expense','salaries', 48000, CURRENT_DATE - 1, 'Monthly wages', $2),
     ($1,'expense','medicines', 6200, CURRENT_DATE - 6, 'Vet medicines', $2),
     ($1,'expense','utilities', 9100, CURRENT_DATE - 3, 'Electricity', $2)`,
    [farmId, userIds.farm_owner],
  );

  const emp = await db.query(
    `INSERT INTO employees (farm_id, user_id, employee_code, full_name, role_title, hire_date, salary, shift)
     VALUES ($1,$2,'E-01','Rashid Worker','Shed worker', CURRENT_DATE - 400, 28000, 'morning') RETURNING id`,
    [farmId, userIds.worker],
  );
  await db.query(
    `INSERT INTO attendance (farm_id, employee_id, work_date, check_in, check_out, source)
     VALUES ($1,$2,CURRENT_DATE, now() - interval '5 hours', NULL, 'mobile')`,
    [farmId, emp.rows[0].id],
  );

  await db.query(
    `INSERT INTO tasks (farm_id, title, task_kind, description, assigned_to, due_at, priority, created_by)
     VALUES
     ($1,'Morning TMR mix','feeding','Mix silage + concentrate for lactating row',$2, now() + interval '3 hours','high',$3),
     ($1,'Clean parlor floor','cleaning','Wash and squeegee after evening milking',$2, now() + interval '8 hours','normal',$3),
     ($1,'Check sick cow udder','health','Follow up mastitis case',$4, now() + interval '1 day','urgent',$3)`,
    [farmId, userIds.worker, userIds.farm_manager, userIds.veterinarian],
  );

  const farmer = await db.query(
    `INSERT INTO farmers (farm_id, code, full_name, phone, village, rate_per_liter)
     VALUES ($1,'F-11','Ghulam Nabi','0301-1111111','Chak 12', 92) RETURNING id`,
    [farmId],
  );
  const route = await db.query(
    `INSERT INTO collection_routes (farm_id, name) VALUES ($1,'East loop') RETURNING id`,
    [farmId],
  );
  await db.query(
    `INSERT INTO milk_collections (farm_id, farmer_id, route_id, quantity_liters, fat_pct, snf_pct, water_pct, density, temperature_c, amount_due, created_by)
     VALUES ($1,$2,$3, 48, 4.2, 8.4, 0.4, 1.028, 6.1, 4416, $4)`,
    [farmId, farmer.rows[0].id, route.rows[0].id, userIds.milk_operator],
  );

  await db.query(
    `INSERT INTO notifications (farm_id, user_id, title, body, severity)
     VALUES ($1,$2,'Vaccination due','FMD booster due within 5 days for GV-100','warning')`,
    [farmId, userIds.farm_manager],
  );
  await db.query(
    `INSERT INTO ai_alerts (farm_id, alert_type, severity, title, body)
     VALUES ($1,'vaccination_due','info','FMD due soon','One or more animals have vaccines due in the next week.')`,
    [farmId],
  );
}
