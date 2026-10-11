# Gates: Phase 4A zero-cost deployment preparation

Scope: Local preparation only; no provision, commit, merge, deployment, real credentials or paid services. Prior Phase 4 evidence is preserved in docs/GATES-phase4-initial.md; Phase 3 findings remain unresolved in docs/GATES-phase3-historical.md.

- [x] G1: Historical evidence preserved and experimental runtime dependencies excluded from cloud package
  CHECK: node scripts/verify-cloud-package.mjs
  EXPECT: Cloud package isolation passed
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0; EXPECT matched; SHA256 18b76f0112cecd7911d519697d5300f2d0dc29bc69567bf9f80847229475fc2d (/tmp/rove-trial-package.log). Manual Git/retained-hash review in docs/PHASE-4A-REVIEW.md; tracked agent and original tests unchanged from HEAD. This verifies inputs, not a built image.
- [x] G2: Audit findings classified and relevant cloud dependencies isolated; high finding patched
  EVIDENCE: npm audit ran against registry with approval. Before 7 affected packages (1 high, 6 moderate); after targeted Undici 7.29.1 override, 5 moderate remain in root Eve/just-bash chain. Cloud production audit exit 0, zero findings. Raw reports in docs/evidence/npm-audit-*.json. Root audit remains FAIL and is explicitly not certified for deployment. No unsafe force downgrade used.
- [x] G3: Typecheck passes
  CHECK: npm run typecheck
  EXPECT: > tsc
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0; EXPECT matched; SHA256 bf89bb99283a44a33bd1eea363914fbbe40d3943ebfb516733111d643f91570f (/tmp/rove-trial-typecheck.log).
- [x] G4: Cloud persistence, restart, approval, authentication and locked trial controls pass locally
  CHECK: npm run test:cloud
  EXPECT: /(?:#|ℹ) fail 0/
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0; EXPECT matched; SHA256 06f29eabe830cfb65cc279a5aa1dfa88bbeaa525ce0b1a3736774e5be0e7da01 (/tmp/rove-trial-cloud.log). 11 passed, zero failed/skipped; includes default locked budgets, startup least privilege, remote TLS bypass rejection, expiry, schedule/job caps, and continued execution of queued jobs at capacity. Separate process restart uses disk-backed PGlite and lease fencing.
- [x] G5: Dashboard verification passes locally
  CHECK: npm run test:dashboard
  EXPECT: Dashboard verification passed
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0; EXPECT matched; SHA256 6fb5f4d64679d05c68cecbe3288a4e39d63d2d33615072e9b97e3d152d6000a9 (/tmp/rove-trial-dashboard.log). Initial sandbox loopback EPERM; approved outside-sandbox rerun passed. Local Chromium exercised login, approval/completion, stop/resume, XSS-safe rendering and responsive viewports. No hosted evidence.
- [x] G6: Application backup and restore round trip passes locally
  CHECK: npm run test:cloud
  EXPECT: backup export and atomic empty-target restore preserve data and stop execution
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0; EXPECT matched; SHA256 06f29eabe830cfb65cc279a5aa1dfa88bbeaa525ce0b1a3736774e5be0e7da01 (/tmp/rove-trial-cloud.log). All six tables exported; non-control rows preserved; corrupted backup transaction rolls back; nonempty target rejected; sequence advances; duplicate identity persists; queue restored stopped. Hosted credentials/TLS/restore not tested.
- [x] G7: Existing regression and Eve integration tests pass locally
  CHECK: npm test
  EXPECT: /(?:#|ℹ) fail 0/
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; exit 0; EXPECT matched; SHA256 cadeac85499a8a86a970d998ddec69d97d3e157a05d20089f5529675a9284abd (/tmp/rove-trial-tests.log). 29 passed, zero failed/skipped, approved loopback/browser run. Final regression rerun includes the scheduler-cap and JSON-driver fixes. Eve fixture integration also exit 0, Controlled Eve integration passed; SHA256 75ff0093b5796fdf26d2b40728fb8b3840fc4c2bafbe361348627be224dcc30f.
- [x] G8: Seven-day zero-cost runbook, provider monitoring and rollback documented
  EVIDENCE: Manual review of docs/PHASE-4A.md and docs/PHASE-4A-REVIEW.md against official Railway/Supabase docs on 2026-10-10. Covers eligibility, credits, provider limits versus app budgets, secret-only setup, session pooler/TLS, offline providers, no submissions, daily export/restore, emergency stop, end-of-trial compute shutdown and non-destructive rollback. No paid recommendation remains in current runbook.
- [ ] G9: Hosted TLS, role grants, pooler, resources, restart and restore verified
  EVIDENCE: BLOCKED: user explicitly prohibits deployment/provisioning/real credentials this turn. Exact post-approval steps in docs/PHASE-4A.md. Local evidence cannot satisfy this gate.
- [x] G10: Cloud container builds and passes networked PostgreSQL smoke under local resource limits
  CHECK: node scripts/verify-cloud-container.mjs
  EXPECT: Cloud container verification passed
  EVIDENCE: 2026-10-10; local; cwd /Users/jacksontaylor/rove; shell /bin/zsh; approved Docker Desktop launch/build/fixture; exit 0; EXPECT matched. Build SHA256 edff734d6f4ac59355138d45ebd1b2dfc38ac615db9a0071bacefa2ae4c338c1 (/tmp/rove-trial-docker-final.log); container test SHA256 c9b79c661657f8ae543d5136a8a4794e5c317c5735f93077dafa0247395da95b (/tmp/rove-trial-container.log). One disposable PostgreSQL 17 fixture, fake credentials, no published ports, least-privilege app role, duplicate/restart/fencing and network export/restore passed. Initial driver JSON-encoding failure fixed and reverified. Image 83,403,034 bytes; short sample 43.18 MiB under 512 MiB, CPU 0.42% under one CPU. Development fixture uses loopback-only TLS bypass; production TLS/hosted resource guarantees and OS image scan are not claimed. Fixtures removed by script.

Readiness: 9 local preparation gates met, 1 blocked, 0 abandoned. Overall deployment readiness BLOCKED, not a deployment approval. Root npm audit still reports five quarantined moderate findings; Phase 3 public browsing remains blocked. No commit, merge, provisioning, deployment, real credentials or paid service was used.

## Release review (current task)

The original G1–G10 above retain their historical evidence; the current review and prerequisite decisions are in docs/PHASE-4A-RELEASE.md. Updated command fingerprints are in docs/evidence/release-checks.json.

- [x] R1: Refreshed audit and actual container dependency inventory agree
  CHECK: node scripts/verify-cloud-image.mjs
  EXPECT: Cloud image inventory passed
  EVIDENCE: 2026-10-10; /Users/jacksontaylor/rove; /bin/zsh; exit 0, EXPECT matched; actual image UID 1000, Node v24.21.0, exactly postgres 3.4.7 and zod 4.5.4 under /app/node_modules. Inventory SHA256 6d01cba8a70cc2d4d390aa14757556e5fa8f329b790dc6cc4b6501ff4986dcee. Refreshed root audit still FAIL: five moderate affected packages, no high/critical; cloud audit clean. Root exception not granted.
- [x] R2: Phase 4 commit manifest excludes preserved Phase 3 diagnostic
  CHECK: node scripts/verify-phase4-commit.mjs
  EXPECT: Phase 4 commit scope passed
  EVIDENCE: 2026-10-10; explicit .gitignore rule, original SHA256 retained; manifest covers every current modified/untracked non-ignored file and excludes the original diagnostic; zero paths staged. Command result/fingerprint in docs/evidence/release-checks.json after final verification.
- [ ] R3: Local container build, full image scan and security regression checks completed
  EVIDENCE: PARTIAL/BLOCKED: build, actual image inventory, PostgreSQL smoke/restore, typecheck, 30 regression tests (12 cloud) and dashboard fixture all exit 0. Origin-target and delayed-disconnect fixes covered. Docker Scout exits 1 asking for login; no scan result; no Trivy/Grype executable. No login, account change or scanner exception authorised. See release-checks.json for exact fingerprints.
- [x] R4: Every deployment prerequisite and security exception has an explicit disposition
  EVIDENCE: docs/PHASE-4A-RELEASE.md enumerates P1–P19. No security exception accepted. Release commit NO-GO pending retained-root-audit disposition; first deployment NO-GO pending image scan, hosted/provider verification and explicit authorisation. All local fixes completed and affected tests rerun; no commit/merge/deployment/provisioning.
- [ ] R5: Owner decision on retained root-audit findings permits release commit
  EVIDENCE: BLOCKED: proposed narrow exception is documented for review only. User instructed stopping before any security exception. No suppression, acceptance record or waiver applied.

Current complete ledger: 12 met, 3 blocked/unmet, 0 abandoned. This is a review completion, not release approval.
