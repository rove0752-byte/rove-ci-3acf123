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
