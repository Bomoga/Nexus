-- Activity strip: events per orbit per 15 minutes. PLAN 5.2 L2-12. Idempotent.
-- materialized_only = false is required: TimescaleDB 2.13+ defaults to true, which would hide
-- anything newer than the last refresh, and L2-12 reads this view with real-time aggregation.
-- WITH NO DATA so this file can run in a transaction; the policy does the first refresh.

CREATE MATERIALIZED VIEW IF NOT EXISTS events_15m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '15 minutes', at) AS bucket,
  orbit,
  count(*) AS count
FROM events
GROUP BY bucket, orbit
WITH NO DATA;

SELECT add_continuous_aggregate_policy('events_15m',
  start_offset      => INTERVAL '2 days',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- The policy only looks back 2 days. After backfilling older git history, run once, outside a transaction:
--   CALL refresh_continuous_aggregate('events_15m', NULL, NULL);
