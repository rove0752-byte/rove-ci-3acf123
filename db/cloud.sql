-- Apply once, with a migration administrator. Private schema is never exposed through PostgREST.
BEGIN;
CREATE SCHEMA rove;
REVOKE ALL ON SCHEMA rove FROM PUBLIC;
CREATE TABLE rove.controls (
 id integer PRIMARY KEY CHECK(id=1), budget_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
 daily_reserved integer NOT NULL DEFAULT 0 CHECK(daily_reserved>=0), worker_seen timestamptz, stopped boolean NOT NULL DEFAULT false,
 concurrency integer NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 8),
 daily_budget integer NOT NULL DEFAULT 0 CHECK(daily_budget BETWEEN 0 AND 100000),
 job_budget integer NOT NULL DEFAULT 0 CHECK(job_budget BETWEEN 0 AND 10000)
);
INSERT INTO rove.controls(id) VALUES(1);
CREATE TABLE rove.jobs (
 id uuid PRIMARY KEY, owner_id text NOT NULL, idempotency_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('checksum','approval_demo','retry_demo','offline_browser')),
 input jsonb NOT NULL, state text NOT NULL CHECK(state IN ('queued','running','awaiting_approval','completed','failed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), due_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
 lease_token uuid, lease_until timestamptz, heartbeat_at timestamptz,
 result jsonb, error text, UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX jobs_queue ON rove.jobs(due_at) WHERE state='queued';
CREATE INDEX jobs_leases ON rove.jobs(lease_until) WHERE state='running';
CREATE TABLE rove.attempts (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES rove.jobs(id), number integer NOT NULL,
 worker_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
 outcome text NOT NULL DEFAULT 'running', reserved_cents integer NOT NULL DEFAULT 0 CHECK(reserved_cents>=0),
 UNIQUE(job_id,number)
);
CREATE INDEX attempts_budget ON rove.attempts(started_at);
CREATE TABLE rove.audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid REFERENCES rove.jobs(id),
 at timestamptz NOT NULL DEFAULT clock_timestamp(), actor text NOT NULL, event text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE rove.approvals (
 job_id uuid PRIMARY KEY REFERENCES rove.jobs(id), requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decision text CHECK(decision IN ('approved','rejected')), decided_at timestamptz, decided_by text
);
CREATE TABLE rove.schedules (
 id uuid PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL, input jsonb NOT NULL,
 next_at timestamptz NOT NULL, interval_seconds integer CHECK(interval_seconds BETWEEN 60 AND 31536000),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- RLS denies direct client access, including on installations with broad public-schema defaults.
ALTER TABLE rove.controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE rove.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rove.attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rove.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rove.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rove.schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA rove FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA rove FROM PUBLIC;
-- Dedicated service identity; provision its LOGIN/password separately in a secret manager.
CREATE ROLE rove_service NOLOGIN;
GRANT USAGE ON SCHEMA rove TO rove_service;
GRANT SELECT, INSERT, UPDATE ON rove.jobs, rove.attempts, rove.approvals, rove.schedules TO rove_service;
GRANT SELECT, UPDATE ON rove.controls TO rove_service;
GRANT SELECT, INSERT ON rove.audit_events TO rove_service;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA rove TO rove_service;
CREATE POLICY service ON rove.controls TO rove_service USING(true) WITH CHECK(true);
CREATE POLICY service ON rove.jobs TO rove_service USING(true) WITH CHECK(true);
CREATE POLICY service ON rove.attempts TO rove_service USING(true) WITH CHECK(true);
CREATE POLICY service ON rove.approvals TO rove_service USING(true) WITH CHECK(true);
CREATE POLICY service ON rove.schedules TO rove_service USING(true) WITH CHECK(true);
CREATE POLICY audit_read ON rove.audit_events FOR SELECT TO rove_service USING(true);
CREATE POLICY audit_append ON rove.audit_events FOR INSERT TO rove_service WITH CHECK(true);
COMMIT;
