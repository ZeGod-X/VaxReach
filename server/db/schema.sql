CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'worker', 'child')),
  phone TEXT,
  facility TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  head TEXT NOT NULL,
  phone TEXT,
  community TEXT,
  district TEXT,
  address TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY,
  unique_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dob DATE NOT NULL,
  sex TEXT,
  account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  household_id TEXT REFERENCES households(id) ON DELETE SET NULL,
  assigned_worker_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  guardian_name TEXT,
  phone TEXT,
  community TEXT,
  district TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS children_one_record_per_account
  ON children(account_id) WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vaccination_schedules (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  vaccine_code TEXT NOT NULL,
  due_date DATE NOT NULL,
  administered_date DATE,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'overdue', 'completed', 'upcoming')),
  source TEXT NOT NULL DEFAULT 'Demo seeded',
  notes TEXT,
  administered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (child_id, vaccine_code)
);

CREATE TABLE IF NOT EXISTS vaccination_drafts (
  id TEXT PRIMARY KEY,
  client_draft_id TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  schedule_id TEXT NOT NULL REFERENCES vaccination_schedules(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  vaccine_code TEXT NOT NULL,
  administered_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected')),
  review_note TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id, client_draft_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS vaccination_drafts_one_pending_per_schedule
  ON vaccination_drafts(schedule_id) WHERE status = 'pending_review';

CREATE INDEX IF NOT EXISTS vaccination_drafts_worker_updated
  ON vaccination_drafts(worker_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at ON audit_log(created_at DESC);
