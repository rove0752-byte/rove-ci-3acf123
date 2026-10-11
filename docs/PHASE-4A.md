# Rove Cloud Foundation (Phase 4A)

This phase is implemented locally and has not been deployed. It adds a small Node 24 worker/API service with a PostgreSQL source of truth. It preserves the existing Eve agent, model, tools and browser restrictions. The additional Eve channel exposes the same `/cloud` and `/v1/cloud/*` routes; a separate worker is required when using that channel. The standalone foundation service runs the scheduler, worker and dashboard together without loading the AI agent or its browser tools.

## Architecture and guarantees

- `cloud/jobs.ts` owns state transitions. All mutations lock the singleton controls row inside a transaction. This intentionally favors low-volume correctness over throughput; independent worker processes share concurrency, stop and budget limits. No Redis, separate queue service or hosted scheduler is needed.
- States: queued → running → completed, failed or queued for retry; queued → awaiting_approval → queued or cancelled. Active jobs may be cancelled. Running cancellation invalidates the lease immediately. Terminal jobs cannot be re-approved or completed by an old worker.
- Claims use a fresh UUID as an attempt and fencing token, with a 30-second lease and heartbeats every 10 seconds. Expired attempts are audited, then requeued or failed at the attempt limit. Failed handlers retry with capped exponential delay. Recovery happens whenever any worker polls, including after a restart.
- Unique `(owner_id,idempotency_key)` prevents duplicate submissions. A key reused with different handler/input/retry settings is rejected. Scheduling time on a duplicate is not an update. Scheduled instances have deterministic occurrence keys. Handler results and completion events commit together. Execution is **at least once**; deterministic handlers tolerate replay. Future side-effect providers would require their own idempotency keys and reconciliation before being enabled.
- One-off jobs use `due_at`; schedules can be one-off or fixed intervals of 60 seconds to one year. Timestamps are UTC; the dashboard converts local datetime input to UTC. Missed recurring occurrences coalesce to one job and advance to the next aligned occurrence. No cron expressions, local-calendar/DST recurrence or unlimited catch-up. Disabling a schedule leaves already queued jobs intact.
- Daily and per-job AI limits use integer USD cents, default zero. Reservations are serialized and counted before use; uncertain/retried attempts are not refunded. Daily accounting rolls over at UTC midnight, based on reservation time. No model provider or AI handler is enabled. Future model work must reserve a worst-case bound before invocation and enforce provider token/cost limits; these foundation budgets do not wrap existing interactive Eve model routes.
- Emergency stop cancels all running jobs, invalidates completion tokens and stops claims/scheduling/reservations. Queued jobs and schedules remain available for explicit resume. This cannot undo an already completed action. Current handlers make no external actions.
- `cloud/browser.ts` defines an offline document snapshot contract and a local implementation. The future cloud provider is deliberately rejected. It does not launch Chromium, accept URLs, load sites or import Phase 1–3 browser paths.

## Access controls

`db/cloud.sql` is a transactional, one-time bootstrap for a new PostgreSQL database, compatible with Supabase PostgreSQL. It uses a private `rove` schema, RLS on every table, no public schema/table privileges, a NOLOGIN `rove_service` group and explicit service policies. Audit events are append-only for that service role. Client roles have no access. There are no SECURITY DEFINER functions or browser database keys.

Use a dedicated LOGIN role that inherits `rove_service`, never the database administrator, Supabase service-role key or database owner. Do not grant this role to `anon`/`authenticated` or expose `rove` through the Data API. The service is trusted across owners; row ownership is enforced by the authenticated application, not a multi-tenant RLS policy. Phase 4A supports one configured owner and one operator token per installation, not multi-user identity or RBAC.

The token must be at least 32 characters, is verified with a timing-safe comparison, and is held only in dashboard memory. Every data route requires it, even on localhost. No query-string authentication or permissive CORS. HTML contains no data or secrets; CSP prevents inline scripts, framing and external resources. Input sizes and job kinds are bounded. Rotate the token by changing the environment and restarting. Use platform request rate limiting and HTTPS before exposing it publicly.

## Zero-cost trial deployment plan — not deployed

This runbook supersedes the paid hosting recommendation in the archived initial ledger. Deploy only the standalone `Dockerfile.cloud` service. Do not deploy the Eve channel or root `npm start`: those surfaces and their budgets are outside this trial. All steps involving accounts, credentials, hosted changes or deployment require the user's later approval.

The trial locks concurrency to **1**, daily/per-job AI budgets to **0**, and handlers to deterministic checksum, approval/retry demonstrations and offline snapshots. No submissions or online browser provider exist in this service. The HTTP controls cannot raise these limits. The non-trial constructor option is used only by local budget-accounting tests. Production startup checks database privileges and stored limits. Remote TLS bypass and common administrator usernames are rejected. A malformed/missing production deadline prevents startup; the deadline must be within seven days. At expiry the scheduler and claims stop; the HTTP service stays available for export and emergency controls, so infrastructure still consumes credit until stopped at the provider.

Trial safeguards also cap new jobs at 100 per UTC day and active schedules at five. SQL transactions roll back a rejected insertion and its audit changes. These are application limits, not a billing guarantee. Recurring schedules should be hourly or slower for this experiment; a one-minute schedule would exhaust the daily allowance. Database errors prevent execution without a persisted lease. Statement/lock/idle-transaction timeouts are 10/5/15 seconds. The worker retries failures; no memory/file queue substitutes for an unavailable database.

### Provider eligibility and zero-dollar boundary

Checked 2026-10-10 against official documentation:

- [Railway trial](https://docs.railway.com/pricing/free-trial): $5 trial credit expires after 30 days; afterward Free offers $1/month credit. Limited trials restrict outbound networking, which can block Supabase. Do not upgrade to bypass this; mark hosted connectivity BLOCKED.
- [Railway plans](https://docs.railway.com/pricing/plans): Free allows one replica, 0.5 GB RAM, one vCPU and 1 GB ephemeral storage. This trial targets those smaller limits even if trial allowances are higher. Neither credits nor resource limits guarantee seven uninterrupted days.
- [Supabase Free](https://supabase.com/pricing): 500 MB database, 5 GB egress, no automatic backups; inactivity can pause projects after one week. No uptime guarantee is claimed. Stay on Free, no paid compute/IPv4/PITR/add-ons.
- [Railway cost controls](https://docs.railway.com/pricing/cost-control) distinguish alerts, which do not stop workloads, from hard usage limits and per-replica CPU/RAM limits. Confirm the account's available controls and remaining credit before approval. Do not add payment details, upgrade, or enable automatic recharge. A dollar-zero out-of-pocket trial depends on remaining free entitlement and refusing paid conversion, not `daily_budget=0` in Postgres.

Use one service, one replica, no volume, no hosted cron, no Railway database, no build auto-deploys, and no model/provider secrets. Set replica limits to 0.5 GB RAM and 1 vCPU in Railway's dashboard; these controls are not asserted by `railway.json`. The container runs unprivileged with a 192 MB V8 heap cap (not an RSS limit). Watch RSS; stop if it approaches 400 MB or repeatedly OOMs. The cloud image built locally (83,403,034 bytes). A disposable networked PostgreSQL fixture passed startup, authentication, duplicate prevention, interrupted-worker recovery, container restart and export/restore. A short local sample was 43.18 MiB RAM and 0.42% CPU under a 512 MiB / one-CPU cap. This is not sustained or hosted sizing evidence. The local container fixture uses NODE_ENV=development and permits TLS off only over shared-namespace loopback; production TLS remains required and unverified against Supabase.

`railway.json` selects the cloud Dockerfile, one replica, `/healthz`, and up to three failure restarts. The health endpoint exposes only status and checks the database schema; it is not a worker-liveness monitor. Observe authenticated `worker_seen` separately. Railway's deployment health check is not continuous alerting. Disable service sleep during the approved seven-day scheduling experiment; if credits cannot cover this, stop rather than upgrade. Nothing durable lives on Railway's ephemeral disk: jobs, attempts, schedules, approvals, controls and append-only audit records live in Supabase. Logs go to stdout. Backups must be stored off-host.

### Database and secrets setup (after approval only)

1. Choose nearby supported regions; confirm full-trial outbound access to the Supabase session-pooler port. Use a fresh Free project and apply `db/cloud.sql` once through the migration administrator. Preserve that schema file alongside exports.
2. Create a dedicated login `rove_runtime` with INHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; grant only membership in `rove_service`. Set its generated password using a secure provider workflow, never checked-in SQL. Do not grant the runtime schema ownership or migration privileges. Check inherited memberships as well as direct grants. Keep `rove` out of exposed Data API schemas.
3. From [Supabase Connect](https://supabase.com/docs/guides/database/connecting-to-postgres), choose shared **session pooling**, generally port 5432 for IPv4 compatibility. Use `rove_runtime.PROJECT_REF` as the pooled username and the actual dashboard hostname. Do not buy the IPv4 add-on. The driver caps its pool at two and disables prepared statements. Session pooling supports the connection-level statement timeouts; transaction pooling is not the target of this runbook.
4. Set server-only `ROVE_DATABASE_URL`, `ROVE_CLOUD_OWNER`, a generated 32+ character `ROVE_CLOUD_TOKEN`, exact HTTPS `ROVE_CLOUD_ORIGIN`, and `ROVE_TRIAL_END` as an ISO UTC timestamp no more than seven days after startup. Railway supplies `PORT`; the container binds `0.0.0.0`. Leave `ROVE_DB_LOCAL` unset. TLS uses `verify-full`; obtain the proper CA via `NODE_EXTRA_CA_CERTS` when needed. Never disable certificate verification. No Supabase API key is needed, and no database URL or privileged key enters browser assets.
5. Run hosted negative privilege checks with the runtime identity: cannot create schema objects, update/delete/truncate audit events, read as anon/authenticated, or bypass RLS. Verify runtime SELECT/INSERT/UPDATE for the required tables and denied ownership operations. Application startup also rejects overprivileged identities. The service is a trusted single-owner application; RLS is not per-user isolation.
6. Test HTTPS dashboard authentication: public shell has no data; all `/v1/cloud/*` operations require bearer authentication. Test wrong/missing tokens, foreign Origin, forged owner/input, approve/reject and attempted budget/concurrency increases. Token lives only in page memory. Use a private operator audience and platform request protection where available; this token scheme is not multi-user login, MFA or RBAC.

### Harmless cloud smoke test and restart (after approval)

The local `npm run test:cloud` test persists a claim to disk, exits its worker with code 17, starts a new process after expiry and proves attempt fencing and duplicate prevention. It has no external side effects. Hosted evidence is still required:

1. Keep the hosted worker stopped and use an empty trial queue. In a trusted operator shell with the dedicated runtime database identity and owner securely configured, run `node --experimental-strip-types scripts/cloud-smoke.ts seed`. It enqueues the fixed checksum twice, proves one ID, leases it for one second, and exits before executing it.
2. Start/restart the approved Railway service after the lease expires. Run `node --experimental-strip-types scripts/cloud-smoke.ts verify`. Require one completed job, expected SHA256, attempt 2 and a lease-expired audit event. Re-run verify to prove idempotency. Save redacted output, revision, times and database endpoint type as **hosted** evidence.
3. Restart the container again; verify the same completed result and history survive. Queue an approval demonstration: it must wait until authenticated approval. Reject a second one; it must never run. Emergency-stop a queued workload, verify no new claims/scheduled instances, then explicitly resume. Do not use real submissions to test any of this.

### Backup/export and restore on Supabase Free

[Supabase recommends off-site exports for Free](https://supabase.com/docs/guides/platform/backups). This repository provides a bounded application-data JSON export for the six `rove` tables. It uses one repeatable-read transaction and Postgres JSON timestamps (preserving microseconds), includes audit identities, and contains no role passwords or provider auth/storage data. It is not a full Supabase project backup. Keep the schema and reviewed code revision with it. The whole export is held in operator memory: suitable for this low-volume seven-day trial, not an unbounded archive.

Daily and before rollback, use a trusted local operator machine, never ephemeral Railway storage:

```sh
# ROVE_DATABASE_URL is injected securely; never put passwords in command arguments.
node --experimental-strip-types scripts/cloud-backup.ts export /secure/offsite/rove-day1.json
shasum -a 256 /secure/offsite/rove-day1.json
```

The command refuses to overwrite a file and creates it mode 0600. Store it on encrypted storage, retain all seven daily versions and the final export, and record SHA256 separately. Target RPO is 24 hours plus any missed export; RTO is unmeasured until a hosted restore rehearsal. Do not commit exported data. Use a read-capable dedicated service login for export. Take an emergency stop and stop the service for a quiescent pre-rollback export where possible.

Restore only into a fresh, isolated database/project after approval, with all workers off:

1. Verify the saved digest, then apply the exact saved `db/cloud.sql` once. Do not drop or overwrite the source database. Create a temporary `rove_restore` login inheriting `rove_service`, with additional INSERT/DELETE on `rove.controls` and UPDATE on the audit identity sequence. Grant no such extra privileges to the runtime. The bootstrap owner can grant these temporary rights; the restore CLI rejects common administrator usernames. Store its password only in the operator environment.
2. Point the operator's `ROVE_DATABASE_URL` at that **new target**, verify the host/project out of band, and run:

```sh
ROVE_RESTORE_EMPTY_TARGET=yes node --experimental-strip-types scripts/cloud-backup.ts restore /secure/offsite/rove-day1.json
```

3. Restore refuses any populated target business table and runs atomically. It restores data/sequence position, forces stop/concurrency 1/AI zero, and expires any running leases. Compare all table counts, job IDs, schedule definitions, approvals, checksum results and audit rows to the export; controls and running lease expiry intentionally differ. Re-export and compare normalized table data, not whole-file hashes (export timestamps differ).
4. Remove the temporary restore login/grants, configure the least-privilege runtime identity, test its denied audit mutations, and inspect uncertain running jobs before resuming. Cancel uncertain jobs if replay would be unsafe; these trial handlers are deterministic. Start the service paused, then explicitly resume and run the smoke test on a separate empty fixture if needed.

Local automated round-trip coverage checks all non-control rows, append sequence advancement, duplicate identity, paused restore and nonempty-target rejection. It passes on PGlite and on local networked PostgreSQL 17 through the actual driver. The local networked check also compares restored rows and rejects a nonempty target. Supabase restore and provider permissions remain BLOCKED until approved infrastructure exists. For a full-project backup beyond this scope, use Supabase's documented `db dump`/native pg_dump workflow and a separate restore rehearsal; do not mistake this application export for auth/storage backup.

### Staged seven-day experiment

| Stage | Actions and exit condition |
|---|---|
| Before day 1 | Approval; verify free account/credits/network eligibility; build image and test startup; configure provider resource/billing controls; apply schema and least-privilege identity; set fixed trial deadline. If any condition fails, stop. |
| Day 1 | Deploy only the cloud service, run auth/approval/stop checks and restart smoke; record hosted evidence; first off-site export. |
| Day 2 | One hourly checksum schedule, no AI/browser/submissions. Verify cadence and coalescing. Record actual daily credit burn. |
| Day 3 | Restart and brief controlled service outage; confirm persisted jobs and one occurrence per scheduled timestamp; check no duplicate completion. |
| Day 4 | Export and restore to an approved isolated target; compare rows and grants; measure restore time. No paid second project. |
| Day 5 | Verify denied unauthenticated mutations and locked budgets; rehearse emergency stop and rotate operator token if approved. |
| Day 6 | Compare total credit use and projected remaining allowance, database size/egress, failures and memory trends. Export. |
| Day 7 | Stop scheduling, final export and digest, stop Railway service before deadline/credit depletion; record findings and rollback readiness. No automatic continuation or paid conversion. |

Twice daily record Railway remaining credit, compute/egress spend and projected depletion time; Supabase database size/egress; process RSS/CPU/restarts; authenticated worker heartbeat age (alert over 60 seconds), failures, lease expiries and queue age. Close the dashboard when not observing: its five-second polling also consumes resources. Stop at 80% of available trial credit, projected exhaustion within 48 hours, 80% of database/egress quota, repeated OOMs, growing failures, or loss of monitoring. These thresholds are operator policy, not automatic provider controls. Configure available provider alerts/hard limits inside the remaining free credit with a margin; if account minimum limits exceed free allowance, do not treat them as zero-cost protection. Stop via the provider while credits remain. No keepalive traffic solely to defeat Free pausing.

### Emergency stop and rollback

Authenticated `POST /v1/cloud/controls` with `{stopped:true,concurrency:1,daily_budget:0,job_budget:0}` cancels running leases and prevents new claims/scheduling/reservations. Queued jobs and schedules stay persisted; in-flight real-world effects could not be undone, but no such handlers are enabled. If API/database access fails, stop the Railway service in the provider dashboard; do not repeatedly restart against a failing database. Stopping application jobs alone does **not** stop hosting consumption.

For rollback: stop service, export the database off-host, preserve audit evidence, restore the last reviewed cloud image/config only if schema-compatible, verify least privilege and controls, then explicitly resume. No down migration, database deletion, force reset, or automatic retention purge. To end the experiment, leave the database preserved/paused and stop the compute service. Any destructive teardown, paid change or continued experiment requires a separate decision.

## Evidence boundaries

See the current [release review](PHASE-4A-RELEASE.md), [GATES.md](../GATES.md), [dependency and branch review](PHASE-4A-REVIEW.md), and `docs/evidence/`. Local PGlite tests exercise SQL, roles/RLS and restart persistence. `node scripts/verify-cloud-container.mjs` additionally exercises the built image against disposable networked PostgreSQL, including backup/restore; it requires Docker and removes its own fixtures. It found and drove correction of JSON parameters being encoded twice by the real driver. Dashboard tests use only local loopback fixtures. Supabase hosted policy, TLS negotiation, session pooling, multi-worker contention, sustained provider resources and OS/image vulnerability scanning remain unverified. Phase 3 findings remain in `GATES-phase3-historical.md`; nothing here resolves or enables public browsing.
