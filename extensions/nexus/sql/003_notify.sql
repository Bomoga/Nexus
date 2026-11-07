-- Nexus live sync support, Tiger Cloud (Postgres + TimescaleDB). PLAN L2-11.
-- Apply once after 001_schema.sql:  psql "$NEXUS_TIGER_URL" -f sql/003_notify.sql   (idempotent: safe to run twice)
--
-- 1. Every table gets updated_at (set on insert, refreshed by a BEFORE UPDATE trigger) and an index on it; the extension polls
--    `WHERE updated_at > $since` when LISTEN is unavailable.
-- 2. AFTER INSERT OR UPDATE triggers send a tiny NOTIFY on channel 'nexus': {"table","id","session_id"}. Ids only, never row
--    text (pg_notify payloads are limited to 8000 bytes). agent_events uses id = '<session_id>:<seq>'.
-- Row-level triggers are supported on TimescaleDB hypertables (they are created on every chunk). ON CONFLICT DO NOTHING inserts
-- that add no row fire nothing, so re-sent outbox writes are silent.

CREATE OR REPLACE FUNCTION nexus_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- events ----
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS events_updated_at_idx ON events (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_events() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.id, 200), 'session_id', left(NULL::text, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_touch_updated_at ON events;
CREATE TRIGGER events_touch_updated_at BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS events_notify ON events;
CREATE TRIGGER events_notify AFTER INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION nexus_notify_events();

-- ---- agent_events ----
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS agent_events_updated_at_idx ON agent_events (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_agent_events() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.session_id || ':' || NEW.seq::text, 200), 'session_id', left(NEW.session_id, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_events_touch_updated_at ON agent_events;
CREATE TRIGGER agent_events_touch_updated_at BEFORE UPDATE ON agent_events FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS agent_events_notify ON agent_events;
CREATE TRIGGER agent_events_notify AFTER INSERT OR UPDATE ON agent_events FOR EACH ROW EXECUTE FUNCTION nexus_notify_agent_events();

-- ---- approvals ----
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS approvals_updated_at_idx ON approvals (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_approvals() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.id, 200), 'session_id', left(NEW.session_id, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approvals_touch_updated_at ON approvals;
CREATE TRIGGER approvals_touch_updated_at BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS approvals_notify ON approvals;
CREATE TRIGGER approvals_notify AFTER INSERT OR UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION nexus_notify_approvals();

-- ---- swarm_reviews ----
ALTER TABLE swarm_reviews ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS swarm_reviews_updated_at_idx ON swarm_reviews (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_swarm_reviews() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.id, 200), 'session_id', left(NEW.session_id, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS swarm_reviews_touch_updated_at ON swarm_reviews;
CREATE TRIGGER swarm_reviews_touch_updated_at BEFORE UPDATE ON swarm_reviews FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS swarm_reviews_notify ON swarm_reviews;
CREATE TRIGGER swarm_reviews_notify AFTER INSERT OR UPDATE ON swarm_reviews FOR EACH ROW EXECUTE FUNCTION nexus_notify_swarm_reviews();

-- ---- sessions ----
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_sessions() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.id, 200), 'session_id', left(NEW.id, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_touch_updated_at ON sessions;
CREATE TRIGGER sessions_touch_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS sessions_notify ON sessions;
CREATE TRIGGER sessions_notify AFTER INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION nexus_notify_sessions();

-- ---- model_call_receipts ----
ALTER TABLE model_call_receipts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS model_call_receipts_updated_at_idx ON model_call_receipts (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_model_call_receipts() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.call_id, 200), 'session_id', left(NEW.session_id, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS model_call_receipts_touch_updated_at ON model_call_receipts;
CREATE TRIGGER model_call_receipts_touch_updated_at BEFORE UPDATE ON model_call_receipts FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS model_call_receipts_notify ON model_call_receipts;
CREATE TRIGGER model_call_receipts_notify AFTER INSERT OR UPDATE ON model_call_receipts FOR EACH ROW EXECUTE FUNCTION nexus_notify_model_call_receipts();

-- ---- tasks ----
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_tasks() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.id, 200), 'session_id', left(NEW.session_id, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_touch_updated_at ON tasks;
CREATE TRIGGER tasks_touch_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS tasks_notify ON tasks;
CREATE TRIGGER tasks_notify AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION nexus_notify_tasks();

-- ---- task_plans ----
ALTER TABLE task_plans ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS task_plans_updated_at_idx ON task_plans (updated_at);

CREATE OR REPLACE FUNCTION nexus_notify_task_plans() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nexus', json_build_object('table', TG_TABLE_NAME, 'id', left(NEW.id, 200), 'session_id', left(NULL::text, 200))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_plans_touch_updated_at ON task_plans;
CREATE TRIGGER task_plans_touch_updated_at BEFORE UPDATE ON task_plans FOR EACH ROW EXECUTE FUNCTION nexus_touch_updated_at();
DROP TRIGGER IF EXISTS task_plans_notify ON task_plans;
CREATE TRIGGER task_plans_notify AFTER INSERT OR UPDATE ON task_plans FOR EACH ROW EXECUTE FUNCTION nexus_notify_task_plans();
