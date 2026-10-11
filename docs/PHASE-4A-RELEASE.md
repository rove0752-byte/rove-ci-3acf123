# Phase 4A release review

Reviewed 2026-10-10 on `phase-4-cloud-foundation`, HEAD `8a3efc4`. No staged files, commit, merge, account changes, provisioning or deployment. No browser provider or live AI call was enabled. Local browser fixture tests do not enable those providers.

**Release commit recommendation: NO-GO pending explicit disposition of the retained root-audit findings.** The scoped changes are locally verified and the exact commit manifest is ready; this recommendation does not silently approve a security exception. **First cloud deployment: NO-GO**, additionally blocked by the unavailable image scan and provider-specific checks/approval below. A source commit is not proof of deployment readiness.

## Remaining npm findings

Fresh `npm audit` reports five moderate affected packages, zero high and zero critical. These are one underlying advisory plus four dependency-path findings, not five separate exploits.

| Package (installed) | Why npm reports it | Exploitability and cloud exposure |
|---|---|---|
| `sprintf-js@1.1.3` | GHSA-hp3w-g68c-fv3c / CVE-2026-97058, unbounded numeric precision | Attacker-controlled format precision can throw an uncaught RangeError and abort the calling operation; availability impact depends on caller exception handling. A local direct call with `%.999f` reproduced RangeError. This does not demonstrate a remotely exploitable Rove route. Absent from cloud application. |
| `just-bash@3.6.0` | Depends on vulnerable sprintf-js | Potentially exposed when untrusted formatting reaches its formatter and the failure is not contained. The dependency finding alone is not proof of an exploitable shell/API path. No shell handler or just-bash package exists in cloud runtime. |
| `eve@0.75.1` | Inherits just-bash finding | Requires reaching that vulnerable nested functionality in an Eve runtime. Eve runtime is not deployed by Dockerfile.cloud. |
| `@agent-browser/eve@0.38.2` | Inherits Eve finding | Same nested dependency risk; this is not a separate browser exploit. Package and browser handlers are absent from the cloud image. |
| `@vercel/connect@2.2.0` | Inherits Eve finding | Same nested dependency risk, not an independently demonstrated Connect vulnerability. Package is absent from the cloud image. |

The [reviewed advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) lists no patched version. Its current web CVSS rating differs from the npm report's cached score; both classify it moderate. No score is used as proof of reachability. Audit suggests incompatible historical framework downgrades; those were not applied. No audit suppression, accepted-risk record, or waiver was created.

The original high-severity **affected package** was guarded-fetch's `undici@7.29.0`, with multiple advisories including high WebSocket denial-of-service and TLS-validation issues. It is now `7.29.1` via a narrowly scoped override, confirmed in installed dependencies and the lockfile. Fresh root audit contains neither Undici nor guarded-fetch findings and reports zero high/critical. This conclusion is about those npm findings, not every component of Node or Debian.

The built image was inspected directly, with networking disabled: `/app/node_modules` contains exactly `postgres@3.4.7` and `zod@4.5.4`, matching its independent lockfile. Its production npm audit reports **zero vulnerabilities**. Runtime UID is 1000; Node is v24.21.0. No `/app/agent`, `/app/scripts`, `/app/docs`, `/app/.git` or `/app/.env` is present. The base image also contains Node, OS packages and global npm tooling, so the entire container cannot be described as containing only two audited packages.

## Security review

- Authentication: all `/v1/cloud/*` routes require the configured 32+ character bearer token, compared with timing-safe equality. Only the empty dashboard shell/assets and status-only health endpoint are public. No query-token or cookie fallback; use a randomly generated token and HTTPS, not a memorable 32-character password.
- Authorisation/isolation: owner identity comes from server configuration, never request input. Queries/mutations bind owner IDs, strict schemas reject extra fields and foreign job ownership is rejected. Jobs have separate inputs, IDs, lease tokens and attempts; stale workers cannot complete cancelled/expired work. One worker is enforced through the locked controls row. This is single-owner application isolation, not a multi-tenant sandbox or per-owner database RLS.
- Secrets: database credentials stay server-side; browser token stays in memory, input is cleared, no localStorage/sessionStorage or URL credential transport. CSP blocks inline/external scripts and framing, and text is rendered with textContent. TLS has explicit `rejectUnauthorized:true`; remote or production TLS bypass is rejected. Runtime role must inherit rove_service, cannot own/create the schema or rewrite audit rows, and must lack administrative flags. Actual Supabase inherited privileges and CA trust still require hosted checks.
- Approvals: approval_demo enters awaiting_approval and executes only after an authenticated decision for the configured owner. Terminal jobs cannot be re-approved; rejection cancels execution. All other handlers are harmless deterministic operations. There is no submission, arbitrary code, URL browsing or AI handler. This mechanism must not be treated as approval coverage for future side-effect providers.
- Abuse/operations: body size, connection count, statement timeouts, attempts, schedules and daily jobs are bounded; no per-IP request-rate limiter or multi-user identity/MFA is implemented. Public operator exposure requires the documented HTTPS/request-protection and monitoring checks. Application budget zero is not a provider billing cap.

Straightforward fixes in this review: reject absolute/foreign-authority HTTP request targets so they cannot replace the configured Origin; discard in-flight dashboard responses after disconnect so they cannot redisplay data. Both have regression coverage. This adds hardening without relaxing any security control.

## Commit boundary

The original `scripts/audit-phase3-boundary.ts` is still present with SHA256 `04684a6150017512ed57bda0acc61d09b140a2e3b97dd60f1f555aa4e761b102`. It is untracked, explicitly ignored and omitted from the intended commit manifest. No file was deleted or moved. Historical findings remain in `docs/GATES-phase3-historical.md`, SHA256 `46489d5f6b06178e023ddb5b91ea15861859671a8bcc07d5b39035a5614007aa`; that ledger is intentionally included as evidence, not as Phase 3 implementation.

[PHASE-4A-COMMIT-FILES.txt](PHASE-4A-COMMIT-FILES.txt) is the precise, one-path-per-line intended file list. `node scripts/verify-phase4-commit.mjs` checks completeness, preserved evidence, ignore status and any staged paths without modifying the index. Nothing is currently staged. Re-run this check after any future explicit staging; `.gitignore` does not prevent a deliberate `git add -f`. Do not use broad staging commands in place of the manifest.

Unrelated code: the Phase 3 diagnostic is excluded. Original Phase 1–2 agent/model/instructions/tools and tests remain unchanged. Existing just-bash/microsandbox dependencies predate this phase. The Phase 4 Eve adapter (`agent/channels/cloud.ts`, `cloud/runtime.ts`, `cloud/run-worker.ts`) is additive Phase 4 work included in the commit, but its Eve hosting path is outside this deployment approval; only `cloud/server.ts` is the Docker entrypoint. Historical ledgers and old evidence snapshots are intentionally retained and distinguished from current release evidence. No temporary logs, exported user data, node_modules, Docker credentials, or secrets belong to this commit.

## Build, scan and validation

The final image rebuild and actual package inventory pass. The disposable PostgreSQL 17 test passes migrations, least-privilege startup, first checksum, duplicate suppression, expired-worker recovery, container restart, API denial/limit checks and networked export/restore. It uses fake credentials and no published ports, removes its fixtures, and does not access Supabase. The loopback fixture permits TLS off in development; production TLS is not thereby certified.

Thirty regression tests pass (including twelve cloud tests), typecheck passes, and the dashboard fixture passes, including delayed-response-after-disconnect. The actual image is 83,403,227 bytes; one short sample was 43.04 MiB / 512 MiB and 0.79% CPU under a one-CPU cap. These figures are neither sustained-load evidence nor a Railway usage estimate.

**Image vulnerability scan BLOCKED:** installed Docker Scout 1.24.0 was invoked with `docker scout cves local://rove-cloud:trial --format sarif --output /tmp/rove-release-scout.json --exit-code`. It exited 1 requesting Docker login, and produced no vulnerability report. Trivy and Grype executables are unavailable. No account login/change or scan bypass was performed. This is not a clean scan. An authorised scanner must evaluate the exact final image before cloud exposure; account/authentication approval or an approved local scanner is required. No security exception for skipping the scan has been accepted.

Evidence hashes and command statuses: [release-checks.json](evidence/release-checks.json). Fresh audit reports: [root](evidence/release-audit-root.json), [cloud](evidence/release-audit-cloud.json). Prior evidence in GATES.md remains historical where superseded by these review results.

## Deployment prerequisites

| ID | Prerequisite | Status | Disposition |
|---|---|---|---|
| P1 | Correct branch, reviewed commit scope, no unrelated changes | PASS | Exact manifest; no staging/commit/merge |
| P2 | Preserve Phase 3 findings, exclude diagnostic from commit/image | PASS | Original hash, ignore rule and scope checker |
| P3 | Resolve original high npm finding | PASS | Undici 7.29.1; fresh root audit zero high/critical |
| P4 | Clean whole-repository npm audit | FAIL | Five moderate findings remain; not suppressed |
| P5 | Audited application production dependencies in actual image | PASS | Exactly postgres and zod; zero cloud npm findings |
| P6 | Cloud Docker build and local networked startup | PASS | Unprivileged image and PostgreSQL fixture pass |
| P7 | Scan final image OS/runtime/global packages | BLOCKED | Scout requires login; no alternative scanner installed |
| P8 | Single-owner dashboard/API authentication | PASS | Local positive/negative tests; random token and HTTPS required at setup |
| P9 | API ownership and task isolation | PASS | Strict inputs, bound owner, lease fencing; single-owner scope only |
| P10 | Secrets and TLS/least-privilege design | PASS | Server-only credentials and fail-closed configuration checks |
| P11 | Approval, cancellation and emergency stop | PASS | Local lifecycle tests; no side-effect providers enabled |
| P12 | Fresh-database bootstrap and application restore | PASS | Transactional db/cloud.sql and local PostgreSQL restore; not an upgrade migration |
| P13 | Railway configuration and ephemeral-disk compatibility | PASS | One replica, PORT/bind, health/restarts, small heap, Postgres persistence |
| P14 | Zero AI budget, offline providers, concurrency one | PASS | Locked application controls and absent provider dependencies |
| P15 | Real Supabase role/RLS, CA/TLS and session-pooler behaviour | BLOCKED | Requires approved Free project and credentials |
| P16 | Railway Free/trial eligibility, outbound network, credit and resource controls | BLOCKED | Must confirm actual account; config alone cannot prove free billing |
| P17 | Hosted smoke/restart/restore/monitoring and seven-day shutdown | BLOCKED | Runbook ready; no hosted execution authorised |
| P18 | Explicit provisioning and deployment approval | BLOCKED | User expressly prohibits these actions in this review |
| P19 | Retained root-audit security exception / release disposition | BLOCKED | Owner decision required before treating the release commit as approved |

## Next actions and decisions

1. Decide whether to accept a narrowly scoped Phase 4A exception for retaining these five root npm findings **only in the non-deployed Eve/developer dependency graph**. Proposed boundary: cloud image must continue to contain only its audited app dependencies; no Eve/browser/shell deployment; no suppression of root audit; review upstream remediation before any scope expansion. This proposal is not approval and has not been applied. If exception is declined, root dependency remediation is required before the release commit recommendation changes.
2. Authorise access to Docker Scout or another local scanner, then scan the final image. Resolve relevant findings, or present each proposed exception for explicit approval. Do not infer a pass from the zero cloud npm count.
3. After the release decision, explicitly approve staging/committing only the manifest paths if desired. No commit is performed by this review.
4. Separately approve provider/region/zero-dollar trial and credential setup. Confirm free entitlements, remaining credits, outbound session-pooler connectivity, one replica and provider resource/billing controls. Do not upgrade a limited account to bypass restrictions.
5. Only after deployment approval, follow PHASE-4A.md: apply schema once to a fresh project, establish the least-privilege login, verify TLS/grants, run `scripts/cloud-smoke.ts seed` with the worker stopped, start the service, then run `scripts/cloud-smoke.ts verify`. Verify approval/stop and off-site restore, record hosted evidence, and follow the seven-day monitoring/shutdown plan.
