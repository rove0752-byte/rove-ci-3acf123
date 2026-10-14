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
