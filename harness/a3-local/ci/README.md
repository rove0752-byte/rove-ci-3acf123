# CI simulation (no --privileged)
Exact command (from the repo root; minimal caps needed by `unshare --net` and `ip link`):
```
docker run --rm --pull never --network none --cap-add SYS_ADMIN --cap-add NET_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -v "$PWD":/src:ro -v ~/rove:/nmroot:ro -v "$PWD/harness/a3-local/ci":/sim:ro \
  rove-browser-pilot:local bash /sim/ci-sim.sh
```
