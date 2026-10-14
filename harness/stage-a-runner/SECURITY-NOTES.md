# Stage A runner — security notes and residual risks (builder claims; for independent review)
Development only, local fixtures only (D-25-3). A3/live use remains NO-GO (D-25-7).

## Trust boundaries
- Untrusted: the browser container (Chromium + page content). `--network none`; only path out is a unix socket to the proxy; `$OUT` mounted read-only; its only writable mount is `$OUT/browser` (umask 077).
- Trusted: proxy (writes `$OUT/proxy`, hash-chained `journal.chain`), fixture (shares the proxy's netns, loopback only), supervisor `run.sh` (writes `$OUT/*`, then `SHA256SUMS` and `MANIFEST.sealed` after every container has exited). `verify-evidence.py` re-checks journal + seal independently.
- No Docker networks are created; no container is `--privileged`; all use `--cap-drop ALL`, `no-new-privileges`, read-only rootfs, uid of the operator. Exact commands per run: `docker-commands.txt` (nonce redacted); effective settings: `containers.inspect`.
- Seal limits: the seal nonce is stored in the evidence dir, so the seal detects accidental or browser-side changes and post-run edits that do not recompute it; it does NOT stop a same-user host process that recomputes it. Off-host signing would be needed for that.

## Residual risk: PID reuse (kill.sh)
- Risk: macOS has no pidfd; between the last identity check and kill(2) a PID could be recycled (ms window).
- Compensating controls: registry entries carry pid + pgid + lstart; identity re-verified immediately before every signal; KILL is per member after re-check; members must start ≥ leader lstart; refuses ancestors, protected supervisors (pid + lstart), session leaders, PID ≤ 1; registry dir 0700; container kills use full ID + Created + per-run nonce label, not PIDs.

## Residual risk: main-page (top-level) heuristic (proxy)
- Risk: `Sec-Fetch-Dest` is not sent over plain http, so top-level = URLs handed to the run + their redirect chain + any request with `Accept: text/html`. A subframe or a script fetch with `Accept: text/html` is treated as top-level.
- Effect errs strict: top-level off-list/robots/method rules terminate instead of block. A page cannot make a top-level request look like a subresource unless it drops `Accept: text/html`, in which case the subresource rules (allowlist, robots, rate, method) still apply and are logged.
- Compensating controls: allowlist applies to every request regardless of class; >5 attempts to one off-list host or >20 A-class blocks terminate; every decision logged with its class.

## Proxy egress
- Proxy container `--network none`; its only upstream is the fixture on 127.0.0.1:8081 via `route` in the pinned policy. Probe (test mode) shows interfaces `lo` only and gateways, VM, metadata, internet, IPv6 and DNS unreachable. Live mode would need a real egress path: not built, not approved.

## CI
- `harness/a3-local/ci/ci-sim.sh` is a LOCAL SIMULATION of the GitHub Actions step, not hosted CI. The workflow has never run on GitHub.

## Round 3 changes (builder claims, pending independent review)
- R3-1: the browser writes only to `/scratch`, a per-run 64 MiB tmpfs volume (uid-owned, 0700), with no host bind. After the browser exits, a `--network none`, cap-drop-ALL holder container that mounts the scratch volume read-only runs `copyout.mjs`. It uses lstat, opens files with O_NOFOLLOW|O_NONBLOCK, and copies regular files only (8 MiB per file, 64 MiB total, 256 entries, depth 4, 30 s timeout). FIFOs, sockets, devices and symlinks (including dangling ones) are refused and the run ends with `auto-terminated: scratch-violation`.
- R3-2/3: `verify-evidence.py` treats any non-regular file as a failure and only reads regular files. The supervisor seals first, then verifies. `evidence_integrity` comes from that post-seal verifier result, followed by a reseal and a second verify. A seal or verify failure gives exit 10 and `evidence_integrity:false`.
- R3-4: robots rules are matched against path + query (RFC 9309). Both the raw and the decoded forms are checked.
- R3-5: Node's built-in Host check is turned off so the proxy can count Host headers itself. A missing or duplicate Host header terminates the run (B-class).
- R3-6: every container and volume carries `rove.a3.sup=<pid>-<lstart>`. The trap covers INT/TERM/HUP/EXIT. On SIGKILL, the next start sweeps resources whose supervisor (pid + start time) is no longer alive. Test leftover checks are scoped by nonce.
- R3-7: outside test mode, policy.json's git blob and policy.sha256 must equal the committed HEAD versions, otherwise the run is refused with exit 8.

## Round 4 changes (builder claims, pending independent review)
- R4-2: production mode (STAGE_A_TEST unset) now refuses unless both of these hold:
  - The working tree is clean under harness/, .github, package*.json and tsconfig.json (untracked files count as dirty).
  - HEAD's full 40-hex id is listed exactly in an approved-commits allowlist. Being an ancestor or descendant of a listed commit is not enough.
- Allowlist location: `~/rove-recovery-evidence/stage-a-runner/APPROVED-COMMITS.txt` by default; `STAGE_A_APPROVED_COMMITS` overrides it.
  - It must be a regular, non-symlink file owned by the running user, not group- or world-writable, and outside the worktree. No container mounts it.
  - Its path and sha256, plus commit_approved, approval_reason and tree_clean, go into summary.json.
  - It was created EMPTY (D-28-4), so production mode currently refuses every commit.
- R4-1: copy-out refuses any name outside `[A-Za-z0-9._-]{1,128}` (reason `bad-name`), so newlines and control characters can't reach logs or the manifest.
  - supervisor.log now labels the pre-integrity line `provisional result=`.
  - The authoritative `final result=… evidence_integrity=…` line is written after post-seal verification and covered by the final reseal.
- R4-3: the startup sweep deletes only resources that have all of: a `rove-a3-` name, a 32-hex `rove.a3.nonce` label, and a well-formed `rove.a3.sup` label. Anything else is logged as `sweep skip-unrecognised` and left alone.
- R4-4: if the browser container still exists after kill + wait, copy-out is skipped. scratch-copy.json then records `browser-still-present` and the run fails.
- Residual risks:
  - Anyone who can write the allowlist, or set STAGE_A_APPROVED_COMMITS, at the user's own uid can approve a commit. That is the same trust level as Docker access. The control is that the path and sha256 are recorded in every summary.
  - The sweep still trusts Docker labels. Anyone with Docker access can forge `rove-a3-`-named resources.
  - Test mode (STAGE_A_TEST=1) skips the approval check by design. Its results are always suffixed `-TEST`.
