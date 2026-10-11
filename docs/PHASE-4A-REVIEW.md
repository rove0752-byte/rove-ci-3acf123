# Phase 4A readiness review — 2026-10-10

Current release decision and refreshed evidence: [PHASE-4A-RELEASE.md](PHASE-4A-RELEASE.md). The release review adds explicit commit scoping, two security hardening fixes and a documented scanner authentication blocker.

Overall: **BLOCKED for deployment**, locally prepared. Nothing was provisioned, committed, merged or deployed; no real credentials, model calls, paid services or public browser providers were used. See GATES.md for final command evidence.

## Branch and Phase 3 carryover

Branch: `phase-4-cloud-foundation`; HEAD: `8a3efc4` (Phase 2). The incoming worktree was already dirty with Phase 4 cloud files, docs, package/lock/tsconfig/README changes and the Phase 3 diagnostic. These were preserved and extended, not reset. No Phase 3 production browser implementation was found: tracked agent model/instructions, library/tools and the three original test files are byte-identical to HEAD. `just-bash` and `microsandbox` were already in the Phase 2 package manifest; they are not newly introduced Phase 3 experiments.

The carried Phase 3 artifacts are the historical ledger and the deliberately failing loopback boundary diagnostic. Keep both as security evidence. The diagnostic is not part of cloud tests or startup. Historical findings remain unresolved: allowed GET subresources can mutate a server, and DNS validation is not connection-bound address enforcement. Public browsing must remain disabled.

| Preserved evidence | SHA256 |
|---|---|
| `docs/GATES-phase3-historical.md` | `46489d5f6b06178e023ddb5b91ea15861859671a8bcc07d5b39035a5614007aa` |
| `scripts/audit-phase3-boundary.ts` | `04684a6150017512ed57bda0acc61d09b140a2e3b97dd60f1f555aa4e761b102` |

Unrelated runtime code is excluded without deletion: Docker uses an allowlisted context and the independent `deploy/cloud` lockfile. It copies only cloud TypeScript and three dashboard assets. Eve, AI/browser libraries, Chromium, microsandbox, experimental scripts, Git metadata and evidence files are absent from that context/runtime dependency graph. The additive Eve channel is preserved but is not an approved deployment target. The initial Phase 4 ledger is archived at `docs/GATES-phase4-initial.md`; its old paid-plan recommendation is superseded.

## npm audit and reachability

Raw before/after/cloud results are retained in `docs/evidence/npm-audit-*.json`. Initial registry access failed in the sandbox; the explicitly approved network rerun succeeded. Audit exits 1 when findings exist, not when an audit passed.

| Finding | Severity / initial reachability | Disposition |
|---|---|---|
| `guarded-fetch -> undici 7.29.0` | Two high advisories (WebSocket subprotocol DoS; BalancedPool TLS validation), five moderate advisories (WebSocket decompression, RetryHandler body leak, response decompression, shared-cache cookie leak, WebSocketStream close), three low advisories (response splitting/truncation and unsafe-method caching). Potentially reachable through root Eve/shell networking; absent from cloud runtime. | Narrow `guarded-fetch` override to **7.29.1**, installed and locked. Audit no longer reports these; regression/Eve fixture tests pass. No force upgrade/downgrade. |
| `sprintf-js <=1.1.3` unbounded precision DoS, GHSA-hp3w-g68c-fv3c | Moderate; potentially reachable when untrusted printf format strings reach just-bash. No claim that root Eve is safe for public use. Cloud imports neither library. | No safe patch offered by current audit. Retain root dependency and explicitly exclude entire chain from deployment. Review upstream fix before any Eve deployment. |
| `just-bash`, `eve`, `@agent-browser/eve`, `@vercel/connect` | Moderate meta-vulnerabilities inherited from sprintf-js (initially also guarded-fetch/undici). These are dependency-path findings, not five independent exploits. | Remain in root audit, absent from cloud manifest/image inputs. Suggested force fixes downgrade Eve to 0.7.4 and related integrations; rejected as unsafe unrelated framework changes. |

Before: **7 affected packages: 1 high, 6 moderate, 0 critical**. After: **5 moderate, 0 high/critical** in the root. Cloud production lock: **0 reported vulnerabilities**, two runtime dependencies (`postgres 3.4.7`, `zod 4.5.4`). `npm audit` does not assess the Node base image/OS or prove absence of vulnerabilities. The Docker build and local networked runtime smoke now pass. An OS/image vulnerability scan has not been performed; npm audit is not such a scan. Installed root Undici tree verifies guarded-fetch uses the patched override; other unrelated installed versions were not changed.

## Readiness by requirement

| Requirement | Status | Evidence / remaining boundary |
|---|---|---|
| Historical evidence / experimental exclusion | PASS locally | Preserved hashes, HEAD comparison, allowlisted cloud package check |
| Dependency remediation | PASS for cloud; FAIL root audit | Patched Undici; five quarantined moderate findings remain outside deployment |
| Supabase least privilege, TLS, pooling | PASS locally / BLOCKED hosted | Two connections, verified TLS, prepared statements disabled, startup role check and negative SQL tests; real CA/pooler/grants not tested |
| Railway resources / ephemeral filesystem | PASS locally / BLOCKED hosted | One replica, small heap, built image and network PostgreSQL smoke; provider CPU/RAM limits still need setting |
| Dashboard/API auth and approval | PASS locally | Authenticated mutations, Origin/owner enforcement, approval waits, rejected elevated limits, dashboard lifecycle |
| Harmless persistence/duplicate/restart smoke | PASS locally / BLOCKED hosted | Disk-backed PGlite claim plus real PostgreSQL container restart, lease fencing and duplicate checks; hosted seed/verify script supplied |
| Budgets / safe failure / stop | PASS locally | Zero AI, one worker, daily job/schedule caps, deadline, transaction rollback, stopped claims and cancellation |
| Free export and restore | PASS application-data round trip / BLOCKED hosted | PGlite and network PostgreSQL round trips; microsecond timestamps, all table data, atomic corrupt-backup rollback, duplicate preservation, sequence continuation, paused restore |
| Seven-day monitoring / rollback | PASS runbook | Credit/quota thresholds, daily off-site exports, stop without paid conversion, no destructive down migration |

## Additional local network-driver finding

The first real PostgreSQL smoke failed duplicate prevention because pre-serialized JSON strings were serialized again by Postgres.js. SQL parameters now pass JSON values directly; both PGlite and network-driver tests pass, including backup/restore. This was fixed before any deployment. Container image size: 83,403,034 bytes. Short sample: 43.18 MiB / 512 MiB, CPU 0.42% under one-CPU limit. Not a load test, hosted resource estimate or bill. The smoke script cleans up its disposable containers.

## Exact next actions

1. Review the passing local build/runtime evidence in GATES.md. Reproduce with `docker build -f Dockerfile.cloud -t rove-cloud:trial .` then `node scripts/verify-cloud-container.mjs` if the image changes. Perform an OS/image scan before public exposure; this run only audited npm dependencies. The original missing Docker daemon was resolved by an approved Desktop launch. Local fixture used fake credentials, no published ports and loopback-only TLS bypass; production TLS is not certified.
2. Review the uncommitted diff and remaining root-audit exception. Commit/merge only if separately approved; preserve the Phase 3 evidence and resolve no findings by hiding them.
3. Obtain explicit approval for the specified zero-dollar, seven-day Railway Free/trial + Supabase Free experiment, account/region choice and credential setup. Verify credit balance, no paid conversion, outbound pooler eligibility and provider limits. If these cannot support the trial, keep it BLOCKED rather than upgrade.
4. Only after approval, follow the database/secret setup and deploy the cloud-only image in PHASE-4A.md. Verify hosted grants, TLS certificate validation, session pooling, HTTPS/auth, smoke/restart, emergency stop and restore. Record evidence as hosted with revision and timestamps. Do not relabel local PGlite results as hosted.
5. Follow the daily trial schedule. Stop compute and export at day seven or earlier threshold; continuation/paid services require a separate decision.
