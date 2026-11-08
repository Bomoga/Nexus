# Tiger Cloud schema

The shared store's tables, run once against the team's Tiger Cloud service (Postgres + TimescaleDB). Every file is idempotent, so running it again is safe.

| File | What it creates | Task |
|---|---|---|
| `001_schema.sql` | Hypertables `events`, `agent_events`, `model_call_receipts`; tables `tasks`, `sessions`, `approvals`, `swarm_reviews`, `task_plans`; indexes | L2-09 |
| `002_aggregates.sql` | Continuous aggregate `events_15m` (events per orbit per 15 minutes) and its refresh policy | L2-12 |
| `003_notify.sql` | `updated_at` columns and triggers, and the `nexus` NOTIFY triggers that live sync listens to | L2-11 |
| `004_activity_ws.sql` | Continuous aggregate `events_ws_15m` (events per workspace and orbit per 15 minutes) and its refresh policy; the activity strip reads this one | L2-18 |

Apply in order, outside any transaction for `002` and `004` (the refresh policies):

```bash
psql "$TIGER_URL" -v ON_ERROR_STOP=1 -f sql/001_schema.sql
psql "$TIGER_URL" -v ON_ERROR_STOP=1 -f sql/002_aggregates.sql
psql "$TIGER_URL" -v ON_ERROR_STOP=1 -f sql/003_notify.sql
psql "$TIGER_URL" -v ON_ERROR_STOP=1 -f sql/004_activity_ws.sql
```

Check it from the extension folder (applies `001` twice and round-trips one row per table inside a transaction that is rolled back, so the team's data is untouched):

```bash
npm run test:int -- schema
```

Rules: every text column is written already redacted (the store runs the secret-pattern redaction first); no foreign keys, because outbox flushes from several machines arrive out of order; unique keys on hypertables include `at`, so dedupe keys are `(id, at)`. `TIGER_URL` is a secret: it lives in your environment or SecretStorage (`nexus.tiger.url`), never in the repo, a log or a prompt.
