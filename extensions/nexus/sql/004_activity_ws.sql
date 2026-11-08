-- Activity strip, per workspace: events per workspace and orbit per 15 minutes. Idempotent.
-- The shared database holds events from more than one repo; events_15m (002) counts them all together, so the strip reads this
-- view filtered by workspace_id (the sha1 of the repo's root commit) instead. 002 and events_15m stay as they are.
-- materialized_only = false is required: TimescaleDB 2.13+ defaults to true, which would hide
-- anything newer than the last refresh, and the strip reads this view with real-time aggregation.
-- WITH NO DATA so this file can run in a transaction; the policy does the first refresh.

CREATE MATERIALIZED VIEW IF NOT EXISTS events_ws_15m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '15 minutes', at) AS bucket,
  workspace_id,
  orbit,
  count(*) AS count
FROM events
GROUP BY bucket, workspace_id, orbit
WITH NO DATA;

SELECT add_continuous_aggregate_policy('events_ws_15m',
  start_offset      => INTERVAL '2 days',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- The policy only looks back 2 days. After backfilling older git history, run once, outside a transaction:
--   CALL refresh_continuous_aggregate('events_ws_15m', NULL, NULL);
