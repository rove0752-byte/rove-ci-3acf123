# Runs the ACTUAL "Harness smoke" step from /src/.github/workflows/a3-harness-smoke.yml, with sudo emulated as env_reset.
set -u
useradd -m runner 2>/dev/null
mkdir -p /opt/hostedtoolcache/node/24/x64/bin; mv "$(command -v node)" /opt/hostedtoolcache/node/24/x64/bin/node
mkdir -p /home/runner/.cache /home/runner/work/_temp; ln -s /ms-playwright /home/runner/.cache/ms-playwright
cp -r /src /home/runner/work/rove; rm -rf /home/runner/work/rove/node_modules; ln -s /nmroot/node_modules /home/runner/work/rove/node_modules; chown -R runner:runner /home/runner
printf '#!/bin/sh\nexec env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root "$@"\n' > /usr/local/bin/sudo; chmod 755 /usr/local/bin/sudo
awk '/name: Harness smoke/{f=1;next} f&&/run: \|/{r=1;next} r&&/^      [-#]/{exit} r{sub(/^          /,"");print}' /src/.github/workflows/a3-harness-smoke.yml > /home/runner/step.sh
echo "### extracted step:"; cat /home/runner/step.sh
cd /home/runner/work/rove
# The step shell has the runner's env (node only on the toolcache path); `id` reports the runner user, as on GitHub.
# The sudo shim resets env exactly like sudo env_reset (secure_path, HOME=/root).
mkdir -p /home/runner/bin; R=$(id -u runner); printf '#!/bin/sh\necho %s\n' $R > /home/runner/bin/id; chmod 755 /home/runner/bin/id
bash -c "env -i PATH=/home/runner/bin:/opt/hostedtoolcache/node/24/x64/bin:/usr/local/bin:/usr/bin:/bin HOME=/home/runner RUNNER_TEMP=/home/runner/work/_temp PLAYWRIGHT_BROWSERS_PATH=/home/runner/.cache/ms-playwright bash -e /home/runner/step.sh" 2>&1 | tail -6
echo "step rc=${PIPESTATUS[0]}"
