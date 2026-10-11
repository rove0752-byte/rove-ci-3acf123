# Gates: Phase 3A permissioned public web

Scope: Exact-host approved public websites, bounded sessions, accessibility-targeted safe interactions and non-sensitive text entry, post-action snapshots, per-request/redirect/subresource network enforcement, regression preservation. Stop on unresolved security blockers; do not commit or enable unrestricted browsing.

- [x] G1: Authored TypeScript passes typecheck
  CHECK: npm run typecheck
  EXPECT: > tsc
  EVIDENCE: 2026-10-09; cwd /Users/jacksontaylor/rove; shell /bin/zsh; npm run typecheck exited 0 and matched > tsc (tool chunk b2d866).
- [x] G2: All existing regression tests pass
  CHECK: npm test
  EXPECT: /(?:#|ℹ) fail 0/
  EVIDENCE: 2026-10-09; cwd /Users/jacksontaylor/rove; shell /bin/zsh; npm test outside sandbox exited 0: 18 passed, 0 failed, 0 skipped; matched fail 0 (tool chunk 0f6411). Sandbox attempt failed on loopback EPERM and Chromium startup permissions; rerun was explicitly approved.
- [x] G3: Eve tool discovery and cross-turn fixture integration pass
  CHECK: node scripts/verify-eve-browser.mjs
  EXPECT: Controlled Eve integration passed
  EVIDENCE: 2026-10-09; cwd /Users/jacksontaylor/rove; shell /bin/zsh; node scripts/verify-eve-browser.mjs outside sandbox exited 0 and matched Controlled Eve integration passed (tool chunk 7a4e6e). Four application-owned tools, zero discovery diagnostics. All 20 assertions passed; verdict passed; retained log SHA256 7d11a0cfc36f7d6fed87cdb92b4a59b92d7021f68115ba2d40d5c6aac4ebac22. Log: /var/folders/2r/78hfyw5x3h12qtq57vw6prb40000gn/T/rove-eve-browser-QSjeeb/eval-output.log. Sandbox attempt failed on loopback EPERM; rerun was explicitly approved.
- [ ] G4: Existing browser transport prevents unintended server changes from permitted subresource GETs
  CHECK: node --experimental-strip-types scripts/audit-phase3-boundary.ts
  EXPECT: Phase 3A transport prerequisite passed
  EVIDENCE: 2026-10-09; cwd /Users/jacksontaylor/rove; shell /bin/zsh; local diagnostic outside sandbox exited 1; success expectation absent (tool chunk 4fd29b). Requests: GET / and GET /resource; serverChanges=1; browserCleanup=true. No script, click or form was involved. This is a reproduced blocker, not a passing security test.
- [ ] G5: Permissioned public-web workflows, blocked actions, cross-origin redirects, unsafe destinations, timeouts and cleanup are implemented and verified
  EVIDENCE: pending; not implemented while security prerequisites are unresolved.
- [x] G6: Phase 1 and Phase 2 production code and regression coverage remain unchanged, with no commit or merge
  EVIDENCE: git diff --exit-code -- agent tests package.json package-lock.json returned 0; production and existing tests unchanged. git status --short lists only GATES.md and the new local diagnostic. Current branch remains phase-3-permissioned-web. No commit, merge, deployment, website approval or public interaction performed.

ABANDON: G5 User-directed stop on unresolved security blocker; public interaction implementation and Phase 3A workflow coverage are not delivered. Resolve connection-bound egress and approved request/action contracts before continuation.

Current Phase 3A ledger: 4 met, 1 failed (G4), 1 abandoned with required handoff (G5). This is not Phase 3A completion.

## Outstanding security review

The existing URL validator resolves a hostname and returns a URL, discarding the approved addresses (`agent/lib/policy.ts:18-20`). The browser then independently connects with `route.fetch` (`agent/lib/browser.ts:68-70`). No address pinning or egress proxy is established by this code. Per-request DNS checks alone do not establish that the connection uses a validated public address. This is a source-level finding; DNS rebinding has not been exercised against public infrastructure.

Exact-host approval also grants no evidence that each endpoint is read-only. GET image, stylesheet, font, document and redirect destinations can perform server-side mutations before a response can be inspected. Disabling JavaScript and forms does not prevent these requests. A local-only diagnostic below tests this against the current transport; it deliberately uses the established test dependency seam for a loopback fixture, never changing production URL policy.

Safe continuation requires a connection-bound public-address enforcement mechanism and a reviewed request/action contract for approved sites (including resources and redirect destinations), or a narrower offline interaction scope. Hostname approval and accessible names alone cannot establish the requested no-unintended-changes guarantee. No public website is configured or contacted during this audit.

## Historical evidence (not current Phase 3A completion)

```text
# Gates: Phase 2 controlled interactions

Scope: Fixture-only, accessibility-targeted browser sessions with bounded state, isolation, snapshots and cleanup; preserve Phase 1 inspection and network policy.

- [x] G1: TypeScript accepts the authored tools
  CHECK: npm run typecheck
  EXPECT: > tsc
  EVIDENCE: Rerun 2026-10-09 after orchestration fix: npm run typecheck; exit 0 (tool chunk 7321bb).
- [x] G2: Allowed actions, blocked actions, isolation, deadlines and cleanup pass with baseline regressions
  CHECK: npm test
  EXPECT: /(?:#|ℹ) fail 0/
  EVIDENCE: Rerun 2026-10-09: npm test outside sandbox; exit 0; 18 passed, 0 failed, 0 skipped (tool chunk a3a2a4). Includes owner isolation, cross-owner snapshot/close rejection, persisted state and browser cleanup. Initial sandbox run was blocked by loopback/Chromium permissions.
- [x] G3: Deterministic Eve discovery and cross-turn interaction verification pass
  CHECK: node scripts/verify-eve-browser.mjs
  EXPECT: Controlled Eve integration passed
  EVIDENCE: Rerun 2026-10-09 outside sandbox: exit 0, Controlled Eve integration passed; verdict passed, all 20 assertions passed (tool chunk ffd4b9). Discovery ready with four application-owned tools and zero diagnostics. Retained log: /var/folders/2r/78hfyw5x3h12qtq57vw6prb40000gn/T/rove-eve-browser-XOKjk4/eval-output.log. Trace inspection confirms start returns a generated UUID and type, click, snapshot and close all receive that exact UUID. Assertions verify typed text persists, checkbox is checked, snapshot retains both changes, and close returns closed=true for that session. Inspection regression checks also pass.
- [x] G4: Existing inspection and URL protection files remain byte-identical; no sandbox Git operations or unrestricted live interactions
  EVIDENCE: Before/after SHA256 identical: browser.ts f40c4d976e63d6eba43e7e01cf0c80fbbbd62399f6121820d89f37586dcfeb52; policy.ts 2dc3a6becfe78918119e39aacac6eff009016c44960280e84aa0e4abfa450788; inspect_page.ts 7f5b48029bab851415f0794126038617149bb105db075f24b97ad2cfc624d5b9. Only Git calls were escalated branch/status reads; branch phase-2-controlled-interactions. Interaction schema has no URL/script input, fixed fixture route never forwards network traffic; action allowlist and denial controls tested.


Resolution: Read the UUID synchronously from the settled start tool call, validate it as a UUID, and send continuations through the owning Eve session. The deterministic fixture model now distinguishes current-turn results from prior history. No UUID is hardcoded; production tools, validation, safety policy and live-interaction restrictions are unchanged. Rechecked the three SHA256 values above on 2026-10-09 and all match. No commit made.

```
