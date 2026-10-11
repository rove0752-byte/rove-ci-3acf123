# Gates: Phase 4A cloud foundation

Scope: Deterministic provider-independent jobs, PostgreSQL access controls, durable worker and scheduler, budgets, dashboard and offline browser seam. No deployment, provisioning, external submissions or model calls.

- [x] G1: Authored application, worker and tests typecheck
  CHECK: npm run typecheck
  EXPECT: > tsc
  EVIDENCE: 2026-10-10; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0, expected > tsc matched. Final output SHA256 bf89bb99283a44a33bd1eea363914fbbe40d3943ebfb516733111d643f91570f (/tmp/rove-phase4-typecheck.log; tool chunk 7ff15b).
- [x] G2: Existing and cloud regression tests pass
  CHECK: npm test
  EXPECT: /(?:#|ℹ) fail 0/
  EVIDENCE: 2026-10-10; same cwd/shell; outside sandbox exit 0; 24 tests passed, 0 failed/skipped; fail 0 matched. Output SHA256 ce11ca034cea2936c444215b91bed612165abf4694577fe22c5b0fd6de8e0497 (/tmp/rove-phase4-tests.log; tool chunk 60f636). Initial sandbox run could not start loopback/Chromium; explicitly approved rerun passed.
- [x] G3: PostgreSQL lifecycle survives worker restart and rejects stale completion
  CHECK: npm run test:cloud
  EXPECT: /(?:#|ℹ) fail 0/
  EVIDENCE: 2026-10-10; same cwd/shell; npm run test:cloud exited 0; 6 tests passed, 0 failed/skipped; fail 0 matched (tool chunk a9014a). All six also passed in the final full-suite log fingerprint recorded under G2. Disk-backed PostgreSQL claim survived exit code 17 in a separate worker process; replacement process recovered after expiry, completed attempt 2, and stale attempt completion was rejected. Tests also cover role denial, append-only audit, approvals, retries, concurrent claim limit, cancellation, stop, scheduling, offline provider and UTC budgets.
- [x] G4: Responsive authenticated dashboard supports job and approval lifecycle
  CHECK: npm run test:dashboard
  EXPECT: Dashboard verification passed
  EVIDENCE: 2026-10-10; same cwd/shell; approved local Chromium/server run exited 0 and matched Dashboard verification passed (tool chunk 981944). Approval → completed, stop/resume, authentication, literal HTML rendering, disconnect and 390/1280px overflow assertions passed. Both screenshots visually inspected. SHA256 mobile 1a99d140f26c6515da50f5594d9be8a6b6f28653fff20f8b1992ab5710b5509b; desktop 23d9499a1afbe1ee290e195ea47bc8f209b76ac98e070ac868954c35e24b04fb; /tmp/rove-cloud-{390,1280}.png.
- [x] G5: Phase 1–2 Eve integration is preserved
  CHECK: node scripts/verify-eve-browser.mjs
  EXPECT: Controlled Eve integration passed
  EVIDENCE: 2026-10-10; same cwd/shell; approved loopback fixture run exited 0 and matched Controlled Eve integration passed (tool chunk 479020). Four application-owned tools, zero discovery diagnostics, all 20 assertions passed. Eval log SHA256 d5db92c7e4d998415da15cce7308ae7989465dd2aa06ebba5da68944b847c049 at /var/folders/2r/78hfyw5x3h12qtq57vw6prb40000gn/T/rove-eve-browser-Vs1aVK/eval-output.log. git diff --exit-code confirmed existing agent config, instructions, library, tools, channels and three existing test files unchanged (tool chunk 7ff15b).
- [x] G6: Hosting costs, deployment steps and evidence limitations documented; no deployment or provisioning performed
  EVIDENCE: 2026-10-10; manual review of docs/PHASE-4A.md and Dockerfile.cloud. Railway/Supabase official pricing checked; recommendation US$30–35/month estimated, subject to usage/tax. Deployment steps require explicit approval and include database identity, TLS, access controls, live restart test and backups. Current branch phase-4-cloud-foundation. No deployment, provisioning, commit, merge, real credential use, model call or public-site interaction performed. Pre-existing scripts/audit-phase3-boundary.ts preserved.

Historical ledger preserved verbatim in docs/GATES-phase3-historical.md. Its Phase 3 security blocker remains unresolved and public browsing remains outside this phase.

## Evidence limits and remaining deployment work

Phase 4A implementation gates: 6 met, 0 unmet, 0 abandoned. This is local implementation verification, not deployment completion.

- PostgreSQL SQL/roles/RLS run on PGlite, an embedded PostgreSQL WASM engine. It is not a mock, but its serialized connection does not establish hosted multi-connection contention, PostgreSQL network driver/TLS/pooler behavior, Supabase project policies or availability. These require approved infrastructure and live verification.
- Restart is a simulated interrupted worker: the claim is persisted, the first worker exits before execution/completion, and a new process recovers it. It is not a host power-loss test.
- Dashboard verification is local; the Eve regression fixture uses a deterministic mock model. Neither is evidence of a live model or deployment. Docker image build/hosted startup have not been exercised.
- Single-owner operator-token authentication; the trusted service role can access all application rows. Multi-user login/RBAC is not implemented. Browser providers remain offline-only.
- AI reservations apply to foundation jobs, default to zero, and have no enabled model provider. They do not constrain pre-existing interactive Eve routes. No general-purpose agent work is queued by this phase.
- Interval recurrence uses UTC and coalesces missed occurrences. UI history is bounded; database history is retained and needs an operator archival policy at scale.
- npm installation reported 7 dependency vulnerabilities (6 moderate, 1 high); only the two pinned database dependencies were added, with existing locked packages unchanged. A separate dependency review is required before exposing the service publicly.
- The historical Phase 3 security blocker remains unresolved. Its failed/abandoned gates are preserved verbatim in docs/GATES-phase3-historical.md and are not claimed as Phase 4A successes.
