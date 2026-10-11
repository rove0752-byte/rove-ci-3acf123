#!/bin/sh
# Root applies the namespace policy, then this process becomes the unprivileged agent.
set -eu
ln -sfn /opt/egress/node_modules /app/node_modules
mode=${ROVE_EGRESS_MODE:?}
case "$mode" in
  enforce) node --experimental-strip-types /app/scripts/container-egress-entry.ts ;;
  control) node --experimental-strip-types /app/scripts/container-egress-entry.ts --prepare-only ;;
  *) echo "Unsupported egress mode" >&2; exit 2 ;;
esac
next=${ROVE_EGRESS_NEXT:-probe}
case "$next" in
  probe) target=/app/scripts/container-egress-probe.ts ;;
  example-pin) target=/app/scripts/example-pin-probe.ts ;;
  example-fetch) target=/app/scripts/fetch-example-page.ts ;;
  structured-pin) target=/app/scripts/structured-pin-probe.ts ;;
  structured-fetch) target=/app/scripts/fetch-structured-page.ts ;;
  *) echo "Unsupported egress program" >&2; exit 2 ;;
esac
exec setpriv \
  --reuid=1000 \
  --regid=1000 \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  -- \
  node --experimental-strip-types "$target"
