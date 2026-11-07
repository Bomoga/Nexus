-- Nexus shared store, Tiger Cloud (Postgres + TimescaleDB). PLAN 5.2 L2-09.
-- Idempotent: safe to run twice. All text columns are expected to be pre-redacted by the writer.
-- No foreign keys on purpose: outbox flushes from several machines can arrive out of order.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Hypertables. Every unique key must include the time column, so dedupe keys are (id, at).
CREATE TABLE IF NOT EXISTS events (
  id            text        NOT NULL,
  at            timestamptz NOT NULL,
  kind          text        NOT NULL,
  orbit         text        NOT NULL,
  from_orbit    text,
  title         text        NOT NULL,
  actor_name    text        NOT NULL,
  actor_kind    text        NOT NULL,
  target        jsonb       NOT NULL,
  workspace_id  text        NOT NULL,
  machine_id    text        NOT NULL,
  auth0_user_id text,
  PRIMARY KEY (id, at)
);
SELECT create_hypertable('events', 'at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS agent_events (
  session_id text        NOT NULL,
  seq        integer     NOT NULL,
  at         timestamptz NOT NULL,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL,   -- the AgentEvent minus sessionId, seq, at, type
  PRIMARY KEY (session_id, seq, at)
);
SELECT create_hypertable('agent_events', 'at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS model_call_receipts (
  call_id           text             NOT NULL,
  at                timestamptz      NOT NULL,
  session_id        text,
  role              text             NOT NULL,
  requested_model   text             NOT NULL,
  served_model      text             NOT NULL,
  cost_usd          double precision NOT NULL,
  baseline_cost_usd double precision,
  optimizations     jsonb            NOT NULL DEFAULT '[]',
  prune_receipt_id  text             NOT NULL,
  PRIMARY KEY (call_id, at)
);
SELECT create_hypertable('model_call_receipts', 'at', if_not_exists => TRUE);

-- Plain tables.
CREATE TABLE IF NOT EXISTS tasks (
  id           text PRIMARY KEY,
  title        text        NOT NULL,
  brief        text        NOT NULL,
  source       jsonb       NOT NULL,
  workspace_id text        NOT NULL,
  status       text        NOT NULL,
  session_id   text,
  created_at   timestamptz NOT NULL,
  code_refs    jsonb       NOT NULL DEFAULT '[]',
  created_by   jsonb
);

CREATE TABLE IF NOT EXISTS sessions (
  id             text PRIMARY KEY,
  task_id        text        NOT NULL,
  model_provider text        NOT NULL,
  model_id       text        NOT NULL,
  branch         text        NOT NULL,
  worktree_path  text        NOT NULL,
  base_commit    text        NOT NULL,
  status         text        NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  machine_id     text        NOT NULL,
  optimizer      jsonb,
  slack_progress jsonb
);

CREATE TABLE IF NOT EXISTS approvals (
  id               text PRIMARY KEY,
  session_id       text        NOT NULL,
  action           jsonb       NOT NULL,
  reason           text        NOT NULL,
  requested_at     timestamptz NOT NULL,
  decision         text CHECK (decision IN ('approved', 'rejected')),   -- NULL until a human decides
  decided_by       jsonb,
  decided_at       timestamptz,
  slack_message    jsonb,
  ciba_auth_req_id text,
  diff_preview     text
);

CREATE TABLE IF NOT EXISTS swarm_reviews (
  id                text PRIMARY KEY,
  session_id        text        NOT NULL,
  approval_id       text        NOT NULL,
  swarm_type        text        NOT NULL,
  status            text        NOT NULL,
  verdict           text,
  summary           text,
  judges            jsonb,
  at                timestamptz NOT NULL,
  duration_ms       integer,
  data_left_machine boolean     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS task_plans (
  id               text PRIMARY KEY,
  source_task_id   text        NOT NULL,
  swarm_type       text        NOT NULL,
  status           text        NOT NULL,
  subtasks         jsonb       NOT NULL,
  created_task_ids jsonb,
  at               timestamptz NOT NULL
);

-- Indexes.
CREATE INDEX IF NOT EXISTS events_orbit_at_idx        ON events (orbit, at DESC);
CREATE INDEX IF NOT EXISTS events_workspace_at_idx    ON events (workspace_id, at DESC);
CREATE INDEX IF NOT EXISTS receipts_session_at_idx    ON model_call_receipts (session_id, at DESC);
CREATE INDEX IF NOT EXISTS approvals_undecided_idx    ON approvals (decision) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS approvals_session_idx      ON approvals (session_id);
CREATE INDEX IF NOT EXISTS swarm_reviews_approval_idx ON swarm_reviews (approval_id);
