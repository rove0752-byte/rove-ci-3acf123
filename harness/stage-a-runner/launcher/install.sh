#!/bin/zsh -f
# Install the trusted launcher from a COMMIT (never the live tree) into <dest> (must not exist, must be outside every
# git repo). Files 0400/0500, dir 0500. Prints the manifest sha256 that Jacko would list in APPROVED-LAUNCHERS.txt.
# Installing to the final location and approving the hash require Jacko (D-30). usage: install.sh <repo> <commit> <dest>
set -eu
export PATH=/usr/bin:/bin:/usr/sbin:/sbin GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset -m 'GIT_DIR' 'GIT_WORK_TREE' 'GIT_INDEX_FILE' 'GIT_OBJECT_DIRECTORY' 'GIT_CONFIG_COUNT' 2>/dev/null || true
REPO=$1 COMMIT=$2 DEST=$3
[ ! -e "$DEST" ] || { echo "refused: $DEST exists"; exit 8; }
mkdir -p "${DEST:h}"; git -C "${DEST:h}" rev-parse --git-dir >/dev/null 2>&1 && { echo "refused: destination inside a git repo"; exit 8; }
umask 077; mkdir "$DEST"
git --no-replace-objects -C "$REPO" cat-file blob "${COMMIT}:harness/stage-a-runner/launcher/a3-launch" > "$DEST/a3-launch"
for f in check-approval.py verify-snapshot.py; do git --no-replace-objects -C "$REPO" cat-file blob "${COMMIT}:harness/stage-a-runner/$f" > "$DEST/$f"; done
chmod 0500 "$DEST/a3-launch"; chmod 0400 "$DEST/check-approval.py" "$DEST/verify-snapshot.py"; chmod 0500 "$DEST"
/usr/bin/python3 -I -c 'import sys,importlib.util as u; s=u.spec_from_file_location("ca", sys.argv[1]+"/check-approval.py"); m=u.module_from_spec(s); s.loader.exec_module(m); print(m.launcher_hash(sys.argv[1]))' "$DEST"
