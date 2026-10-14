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

## Round 7 changes (builder claims, pending independent review)
- R7-1: GIT_NO_REPLACE_OBJECTS=1 is exported, and every git call passes `--no-replace-objects`, including those inside verify-snapshot.py and check-approval.py.
  - Production refuses if any `refs/replace/*` ref exists, or if `info/grafts`, `objects/info/alternates` or `shallow` exists in the common git dir.
  - verify-snapshot.py no longer trusts `ls-tree`. It reads raw objects through `cat-file --batch` and re-hashes the commit and every tree object itself, so a substituted or corrupted object file is detected. Blobs are compared by recomputing their ids from the snapshot's bytes.
- R7-2: run.sh pins `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`.
  - python3 and git are resolved from a fixed list (/usr/bin, then /opt/homebrew/bin, then /usr/local/bin), and Python runs with `-I`.
  - In production, registry.sh, check-approval.py and verify-snapshot.py are extracted from HEAD, after the replace/graft refusal, and sourced or run from the private git home.
  - A PATH python3 shim with sitecustomize (the round-6 harness) is now provably ignored (test R7-2).
- R7-2 harness for the R6-2 end-to-end test: in a throwaway clone, the test commits a one-line change to check-approval.py's DEFAULT that points at a fake home, and approves that clone commit in a fake allowlist.
  - It asserts that the commit differs from the reviewed code by exactly that one line, and that the real allowlist is unchanged and empty.
- R7-3: sweep log lines now say `sweep stale snap …` or `sweep stale ghome …`.
- **R7-4 (residual, newly documented): the approval anchor lives in the repo.** check-approval.py (with its DEFAULT path) and run.sh come from the commit being checked. So a candidate commit that rewrites its own checker or allowlist root can approve itself.
  - The R6-2 harness shows exactly this. The approval gate protects against running *unreviewed content under a reviewed launcher*, not against a hostile launcher.
  - Compensating controls: the operator must launch a reviewed run.sh, recorded via head_commit and run_snapshot. The real allowlist is empty.
  - Proposed fix (needs a decision): a trusted launcher and checker installed OUTSIDE the repo with a recorded hash, which reads the fixed allowlist and treats the repo only as data.
- Still trusted: /usr/local/bin and /opt/homebrew/bin (user-writable on some Macs) for docker, plus node_modules (lockfile hash only).

## Round 8: trusted external launcher (R7-4) and R8-1 (builder claims, pending independent review; D-30)
**Design**
- The launcher bundle has 3 files from one reviewed commit: `launcher/a3-launch`, `check-approval.py` and `verify-snapshot.py`.
- `launcher/install.sh <repo> <commit> <dest>` installs it from git objects (`cat-file`, no replace refs, never the live tree) into a NEW dir outside every git repo. Files are set to 0500/0400 and the dir to 0500.
- install.sh prints the **manifest hash**: sha256 over the sorted `<sha256>  <name>` lines of the 3 files.
- Approval: the manifest hash must be listed in `APPROVED-LAUNCHERS.txt`, in the same fixed, getpwuid-home directory as APPROVED-COMMITS.txt, with the same rules (regular file, not a symlink, owned by the user, not group/world-writable, outside every git repo). It is not created, so nothing is approved.
- Every time it runs, `a3-launch <repo> <out> <wall> <urls…>`:
  1. re-execs itself with `env -i`, keeping only a fixed PATH, USER, TMPDIR and LANG (plus A3_REGISTRY and A3_KILL_LOG). This drops GIT_*, PYTHON*, DOCKER_*, DEVELOPER_DIR and SDKROOT.
  2. self-checks its dir: exact file set, no write bits, owned by the user, not in git, manifest hash approved. Otherwise it refuses.
  3. treats the repo as data: no replace refs, grafts, alternates or shallow; no non-`H` index flags; whole tree clean; HEAD in APPROVED-COMMITS.
  4. extracts `git archive HEAD`, verifies it object-by-object with **its own** verify-snapshot.py, and makes it read-only.
  5. runs the **snapshot's** run.sh, passing A3_LAUNCHER_DIR, A3_LAUNCHER_SHA256 and A3_REPO.
- run.sh in production also requires all of these, or refuses with exit 8:
  - A3_LAUNCHER_DIR is set;
  - run.sh itself is not inside the live repo, i.e. it is running from a launcher snapshot;
  - the launcher dir passes the same check-approval `--launcher-dir` check.
  - It then repeats all its own git checks.
- Recorded in the sealed summary.json: launcher_dir, launcher_sha256, launcher_approved, launcher_reason.

**R8-1**
- run.sh unsets DEVELOPER_DIR, SDKROOT and every DOCKER_* variable.
- It pins `DOCKER_HOST=unix://<passwd home>/.docker/run/docker.sock` (or /var/run/docker.sock) with an empty private DOCKER_CONFIG, so caller contexts, plugins and credential helpers aren't used.
- Recorded: docker_host, docker_server_id (`docker info .ID`), image_ids (`.Id` of both images), and toolchain (`xcode-select -p`).
- **R8-3 (uniform refusal):** every tampering refusal, in both run.sh and the launcher, now exits **8** with `refused: …`. That includes `git archive` failing on a corrupted object, which used to be exit 5 "STOP".

**Residual risks** (same-user trust, documented):
- A same-user actor can build their own snapshot and run its run.sh with A3_LAUNCHER_DIR pointing at the real approved launcher dir, skipping the launcher. A3_LAUNCHER_DIR is only a path, so it doesn't attest who the caller was.
  - Compensating controls: the content still has to be an approved commit (run.sh repeats every git check against A3_REPO), and the evidence records the launcher hash.
  - A real attestation would need OS-level separation (a separate user account or a signed helper).
- launcher_sha256 in the evidence is computed by the run.sh that ran, so the evidence still comes from the code under test. It is only meaningful when that run.sh comes from an approved commit, which the launcher enforces.
- These remain unchanged:
  - Docker is a trusted computing base;
  - node_modules is not integrity-checked;
  - /usr/local/bin and /opt/homebrew/bin are trusted for docker.

## Round 9 changes (builder claims, pending independent review)
**R9-1: no caller-settable marker; exact environment; no test mode under the launcher**
- The A3_LAUNCH_CLEAN marker is removed. `a3-launch` always runs in two stages:
  - **Stage 1** copies the 3 launcher files into a private dir (below), then `exec /usr/bin/env -i` with only PATH (fixed), LANG=C, USER (`id -un`), TMPDIR (the fixed per-user temp dir from `getconf DARWIN_USER_TEMP_DIR`, never the caller's TMPDIR) and, if set, A3_REGISTRY and A3_KILL_LOG. It runs `/bin/zsh -f <copy>/a3-launch --stage2 <origin> …`.
  - **Stage 2** can be called directly by anyone, so it trusts nothing:
    - it must be running from a private copy;
    - the environment variable *names* must be within {PATH, LANG, USER, TMPDIR, A3_REGISTRY, A3_KILL_LOG, PWD, OLDPWD, SHLVL, HOME, LOGNAME, `_`};
    - PATH, LANG, USER and TMPDIR must equal the fixed values;
    - otherwise it exits 8 with `refused: unexpected environment variable in launcher: <name>` or `unexpected PATH/LANG/USER/TMPDIR`.
  - HOME and LOGNAME are allowed only because zsh sets them itself. HOME is then overwritten from getpwuid, and neither is passed on.
- So STAGE_A_TEST, CMD/PROBE hooks, DEVELOPER_DIR, SDKROOT, GIT_*, PYTHON* and DOCKER_* never reach the launcher's git or python3, or run.sh.
- run.sh is started with an explicit `env -i` list: PATH, LANG, USER, TMPDIR, HOME, the optional A3_REGISTRY/A3_KILL_LOG, A3_LAUNCHER_DIR, A3_LAUNCHER_ORIGIN, A3_LAUNCHER_SHA256, A3_REPO and A3_LAUNCH_SNAPSHOT_VERIFIED.
- run.sh additionally refuses (exit 8) **test mode whenever A3_LAUNCHER_DIR is set** (`test mode is not allowed under the launcher`).
- Tests (R9-1):
  - the reviewer's forged `A3_LAUNCH_CLEAN=1` with STAGE_A_TEST=1, CMD, DEVELOPER_DIR, SDKROOT and GIT_ALTERNATE_OBJECT_DIRECTORIES through the launcher gives a *production* run (test_mode false, result completed) and the CMD hook never runs;
  - a direct `--stage2` call with each of STAGE_A_TEST, CMD, DEVELOPER_DIR, SDKROOT, A3_LAUNCH_CLEAN and GIT_DIR, a modified PATH, or a foreign TMPDIR is refused, and its copy is removed;
  - `--stage2` from the installed dir is refused, and the installed launcher is left intact;
  - run.sh with A3_LAUNCHER_DIR and STAGE_A_TEST=1 is refused.

**R9-3: hash and run the same bytes (TOCTOU)**
- Stage 1 copies the files into `<user temp>/rove-a3-lcopy-<pid>-<lstart>.XXXXXX` (dir 0500, a3-launch 0500, the .py files 0400). Stage 2 self-checks and **hashes the copy**, then runs the copy's check-approval.py and verify-snapshot.py. run.sh's launcher gate also checks the copy (A3_LAUNCHER_DIR).
- The installed origin must also be approved with the same manifest hash (`installed launcher at <origin> not approved or differs from the copy that runs`).
- Both dirs are recorded in summary.json: launcher_dir is the copy, launcher_origin is the installed dir.
- Stage 2 proves it is running from a private copy *before* it arms the cleanup trap:
  - the real path is directly under the fixed user temp dir;
  - the name matches `rove-a3-lcopy-*`;
  - it is not a symlink.
  So every later refusal removes the copy, but a direct call can never delete the installed launcher.
- Round-9 finding: the first attempt checked the environment before arming the trap, so early refusals leaked six copies. The fix is the ordering above. run.sh's stale-dir sweep now also covers `rove-a3-lcopy-*` (copies left by SIGKILL; the same PID+lstart liveness rule applies).
- Tests (R9-3):
  - the copy is a `rove-a3-lcopy-` path, its hash equals the approved hash, and it is gone after the run;
  - a swapped copy (modified verify-snapshot.py) run as stage 2 against an approved origin is refused `launcher-not-approved`, and the swapped copy is removed.
- Residual risk: an approved copy can't be modified after hashing by anyone except the same user (dir 0500). A same-user actor could still chmod it during the run. This is the same same-user limit as R9-2.

**Structural residual risks: R9-2 and self-attestation (documented, not fixed)**
- *R9-2:* the launcher gate in run.sh is advisory against a same-user actor. That actor can `git archive` an approved commit themselves, verify it, and run its run.sh with A3_LAUNCHER_DIR pointing at a real approved launcher (or a copy of one). Every file and env var involved is writable or settable by the same uid, so no in-process check can tell "the launcher ran me" from "someone claimed it did".
- *Self-attestation:* summary.json, SHA256SUMS and MANIFEST.sealed are written by the run.sh that ran, and verify-evidence.py is run by the same user. The evidence attests only to code that was itself approved; it is not an independent observer.
- *Compensating controls today:*
  - the content must still be an approved commit: run.sh repeats every git check, the snapshot is verified object-by-object, and launcher_origin plus both hashes are recorded;
  - tampering refusals are uniform (exit 8);
  - Docker and network isolation (`--network none`, proxy over a unix socket) still bound what any run can do;
  - Jacko alone edits the allowlists;
  - each round gets an independent review.
- *What OS-level separation would need (not built):*
  - a dedicated macOS user (e.g. `_rovea3`) that owns the launcher, both allowlists, the evidence root and, ideally, its own Docker daemon/socket. Jacko's account would have read-only access.
  - a narrowly scoped entry point (a sudoers rule for exactly `/path/a3-launch` with env_reset, or a launchd daemon with a socket API) that takes only (repo path, commit, urls), does the snapshot and runs as that user;
  - evidence signed with a key only that user can read, verified by Jacko's account against the public key;
  - optionally, a code-signed helper or notarised binary so the launcher's identity is checked by the OS, not by itself.
  - Until that exists, Stage A evidence proves "an approved commit produced this" only under the assumption that Jacko's account is not hostile.

**Residual-risk list (updated)**
- R9-1: the remaining exposure is an actor who can run arbitrary code as the user. They can still call run.sh directly in test mode (marked `-TEST` and never production), or rebuild a stage-2 environment by hand. That reduces to R9-2.
- R9-3: same-user chmod or modify of the private copy during a run (see above).
- R9-2 and self-attestation: structural, as above.
- Unchanged: Docker is a trusted computing base; node_modules is not integrity-checked; /usr/local/bin and /opt/homebrew/bin are trusted for docker; PID reuse; the main-page heuristic.

**R9-4: staging-path correction**
- Earlier reports referred to the staging copy loosely. The exact location is `~/rove-recovery-evidence/stage-a-runner/launcher-staging/<short commit>/` (the round-8 copy is `launcher-staging/ae2dd48/`).
- It is a review copy only. It is not installed in the fixed launcher location, and APPROVED-LAUNCHERS.txt does not exist.
