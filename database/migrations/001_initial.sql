BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS emr;
SET search_path TO emr, public;

CREATE OR REPLACE FUNCTION emr.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS app_users (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('viewer','researcher','operator','supervisor','admin')),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_code    TEXT NOT NULL UNIQUE,
  medical_code    TEXT,
  full_name       TEXT,
  birth_year      INTEGER CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2200),
  sex             TEXT,
  source_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS encounters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_key   TEXT NOT NULL UNIQUE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  admission_time  TIMESTAMPTZ,
  discharge_time  TIMESTAMPTZ,
  diagnosis       TEXT,
  status          TEXT,
  source_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (discharge_time IS NULL OR admission_time IS NULL OR discharge_time >= admission_time)
);

CREATE INDEX IF NOT EXISTS idx_encounters_patient ON encounters(patient_id, admission_time DESC);

CREATE TABLE IF NOT EXISTS ward_stays (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id    UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  department_code TEXT,
  department_name TEXT,
  room_code       TEXT,
  bed_code        TEXT,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  source_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_ward_stays_encounter ON ward_stays(encounter_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ward_stays_room ON ward_stays(room_code, started_at DESC);

CREATE TABLE IF NOT EXISTS patient_days (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id             UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  work_date                DATE NOT NULL,
  encounter_day_key        TEXT NOT NULL UNIQUE,
  legacy_patient_day_key   TEXT,
  room_code                TEXT,
  department_code          TEXT,
  doctor_name              TEXT,
  status                   TEXT,
  source_data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (encounter_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_patient_days_work_date ON patient_days(work_date DESC);
CREATE INDEX IF NOT EXISTS idx_patient_days_legacy_key ON patient_days(legacy_patient_day_key);

CREATE TABLE IF NOT EXISTS order_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_day_id  UUID NOT NULL REFERENCES patient_days(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL DEFAULT 'emr',
  source_date     DATE,
  raw_order_text  TEXT,
  raw_progress_text TEXT,
  content_hash    TEXT NOT NULL,
  source_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_day_id, content_hash)
);

CREATE TABLE IF NOT EXISTS order_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_document_id UUID REFERENCES order_documents(id) ON DELETE CASCADE,
  patient_day_id    UUID NOT NULL REFERENCES patient_days(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  event_time        TIME,
  normalized_name   TEXT,
  raw_text          TEXT,
  structured_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_events_patient_day ON order_events(patient_day_id, event_type);

CREATE TABLE IF NOT EXISTS classification_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parser_version  TEXT NOT NULL,
  rule_version    TEXT,
  source_hash     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS classified_orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_day_id        UUID NOT NULL REFERENCES patient_days(id) ON DELETE CASCADE,
  classification_run_id UUID NOT NULL REFERENCES classification_runs(id) ON DELETE RESTRICT,
  source_order_hash     TEXT,
  care                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  medications           JSONB NOT NULL DEFAULT '{}'::jsonb,
  procedures            JSONB NOT NULL DEFAULT '[]'::jsonb,
  supplies              JSONB NOT NULL DEFAULT '{}'::jsonb,
  other_orders          JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_day_id, classification_run_id)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id              UUID PRIMARY KEY,
  session_id      TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  queue_type      TEXT NOT NULL DEFAULT 'standard',
  status          TEXT NOT NULL CHECK (status IN ('queued','running','cancel_requested','cancelled','succeeded','failed','unknown_after_restart')),
  requested_by    TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  requested_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code      TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status, created_at);

CREATE TABLE IF NOT EXISTS task_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_run_id     UUID NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  patient_day_id  UUID REFERENCES patient_days(id) ON DELETE SET NULL,
  patient_code    TEXT,
  work_date       DATE,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','skipped','succeeded','failed','cancelled','unknown')),
  result_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code      TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_run_id, patient_day_id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_item_id    UUID NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
  attempt_no      INTEGER NOT NULL CHECK (attempt_no > 0),
  status          TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  error_code      TEXT,
  error_message   TEXT,
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (task_item_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id        TEXT,
  actor_role      TEXT,
  session_id      TEXT,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_key_hash TEXT,
  outcome         TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash   TEXT,
  event_hash      TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_session ON audit_events(session_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION emr.prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION emr.prevent_audit_mutation();

CREATE TABLE IF NOT EXISTS sync_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     TEXT NOT NULL,
  source_ref      TEXT,
  status          TEXT NOT NULL,
  requested_by    TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  stats           JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id    UUID REFERENCES encounters(id) ON DELETE CASCADE,
  patient_day_id  UUID REFERENCES patient_days(id) ON DELETE CASCADE,
  storage_path    TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256          TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (storage_path, sha256)
);

CREATE TABLE IF NOT EXISTS research_exports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by    TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  dataset_key     TEXT NOT NULL,
  identified      BOOLEAN NOT NULL DEFAULT FALSE,
  purpose         TEXT,
  filters         JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count       INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  output_hash     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['app_users','patients','encounters','patient_days','task_runs','task_items']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON emr.%I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON emr.%I FOR EACH ROW EXECUTE FUNCTION emr.set_updated_at()', table_name, table_name);
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version         TEXT PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO schema_migrations(version) VALUES ('001_initial') ON CONFLICT DO NOTHING;

COMMIT;
