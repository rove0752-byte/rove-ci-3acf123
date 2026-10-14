# CI simulation (SIMULATED — not hosted CI; no --privileged)
Docker's DEFAULT seccomp and AppArmor profiles; only SYS_ADMIN + NET_ADMIN are added (needed by `unshare --net` and `ip link`).
Exact command (from the repo root):
```
docker run --rm --pull never --network none --cap-add SYS_ADMIN --cap-add NET_ADMIN \
  -v "$PWD":/src:ro -v ~/rove:/nmroot:ro -v "$PWD/harness/a3-local/ci":/sim:ro \
  rove-browser-pilot:local bash /sim/ci-sim.sh
```
Builder claim (R3, 2026-10-14): this exact command passed locally on Docker Desktop (macOS); output in
~/rove-recovery-evidence/stage-a-runner/r3-1145/ci-sim.txt. Note: Docker Desktop's VM kernel may differ from a hosted runner's.
