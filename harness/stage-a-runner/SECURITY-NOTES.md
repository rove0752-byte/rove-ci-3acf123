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

## Round 5 changes (builder claims, pending independent re-verification; R4-2 condition per D-28)
- R5-1: production's clean-tree check now covers the WHOLE tree: `git status --porcelain --untracked-files=all -- . ':(exclude)node_modules'`. Modified and untracked files count, including agent/lib.
- R5-2: STAGE_A_APPROVED_COMMITS is honoured ONLY in test mode. Production always reads `<passwd home>/rove-recovery-evidence/stage-a-runner/APPROVED-COMMITS.txt`, taken from getpwuid, not $HOME. That file is empty, so production refuses everything.
- R5-3: `check-approval.py` refuses an allowlist whose real directory is inside ANY git repo, worktree or `.git` dir (`git -C <dir> rev-parse --git-dir`; covers ~/rove and ~/rove-wt/*). It also refuses symlinks, group/world-writable files, files owned by another uid, and anything inside the current worktree.
- R5-4: containers no longer mount the live worktree.
  - After the checks, production extracts `git archive HEAD` into a private, read-only `$TMPDIR/rove-a3-snap-<pid>.*` and re-verifies the snapshot's policy against the pin.
  - /app (proxy), /runner (browser), fixture.mjs and copyout.mjs, and the host-side verify-evidence.py all come from the snapshot.
  - Test mode copies the working files (tracked + untracked, not ignored) unless `STAGE_A_TEST_SNAPSHOT=git-archive`.
  - summary.json records `run_snapshot` and `node_modules_lock_sha256`. The snapshot is removed on EXIT.
- Remaining TOCTOU / residual risks, all same-user trust:
  - run.sh, registry.sh/kill.sh and check-approval.py run from the live tree. A same-user process could still swap them between `git status` and their execution.
  - node_modules is a live read-only mount outside git. Only its `.package-lock.json` hash is recorded; package contents aren't verified.
  - Compensating controls: the whole-tree clean check; head_commit, run_snapshot and node_modules_lock_sha256 recorded in the sealed evidence; an empty allowlist; NO-GO for live mode.
  - A SIGKILLed supervisor leaves its snapshot dir behind. It is named `rove-a3-snap-<pid>-<lstart>.*` and is removed by the next start's sweep, only when owned by this user, not a symlink, and its supervisor is dead (fix commit after 167f2d5). It holds no secrets; it is a read-only copy of tracked files.
- Test-suite consequence: production can no longer be run end-to-end by the suite, because the allowlist is fixed and empty and adding entries needs Jacko's approval.
  - Runs default to test mode (results carry `-TEST`).
  - Production is tested on its refusal paths.
  - The approval logic is tested by calling check-approval.py directly.

## Round 6 changes (builder claims, pending a new independent review per D-29)
- R6-1 git environment: run.sh unsets every GIT_* and PYTHON* variable and sets GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, and HOME/XDG_CONFIG_HOME to a private temp dir. Every git call adds `-c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false`.
- R6-1 index flags: production refuses if any `git ls-files -v` entry isn't `H`, which catches skip-worktree, assume-unchanged and similar.
- R6-1 snapshot verification: `verify-snapshot.py` recomputes every blob id in Python and compares it with `git ls-tree -r HEAD`, including modes, symlinks, missing files and extra files. A mismatch refuses the run with exit 8.
  - This is the control against repo-local filters, export-subst and export-ignore (from .git/config or .git/info/attributes), which command-line flags can't fully disable.
  - The snapshot's policy hash is then re-checked against both the pin committed in HEAD and the live pin.
- R6-1 trusted helpers: in production, check-approval.py and verify-snapshot.py come from `git cat-file blob HEAD:…` into the private temp dir, never from the live tree.
- New summary.json fields: snapshot_verified (e.g. "ok 170") and snapshot_policy_sha256.
- R6-2 end-to-end production test: a throwaway clone, a fake passwd home in a temp dir, and a python3 shim on PATH that changes only pwd.getpwuid. Everything else is the unchanged production code path, with local fixtures and --network none.
  - Why it can't enable real production: the shim and fake home exist only inside the test's temp dir and process tree. The real APPROVED-COMMITS.txt is asserted unchanged and empty. Planting a python3 earlier on PATH already requires same-user code execution.
  - The pin re-check can't be triggered on its own, because any change to the snapshot's policy is caught first by blob verification (tested with a policy.json smudge filter). The test asserts snapshot_policy_sha256 equals the pin.
- Residual risks (same-user trust):
  - run.sh and registry.sh/kill.sh still run from the live tree. The PATH lookups for python3, git, docker and shasum are trusted.
  - node_modules isn't integrity-checked; only its lockfile hash is recorded.
- Private git homes are named `rove-a3-ghome-<pid>-<lstart>.*` and, like snapshots, are swept at the next start after a SIGKILL.
