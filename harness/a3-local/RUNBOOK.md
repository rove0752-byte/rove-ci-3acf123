# A3-local kill switch runbook
- Stop everything: `zsh harness/a3-local/kill.sh` · one run: `kill.sh <registry-name>`. Log: `~/.rove-a3/kill.log`.
- kill.sh only acts on registry entries (`~/.rove-a3/registry`) and refuses: PID/pgid ≤ 1, any pid/pgid in its own live
  ancestry, any live protected supervisor (`~/.rove-a3/protected`, pid + lstart, written by runner.sh/run.sh for their
  lifetime), session leaders, non-leaders, start-time mismatches, unverifiable orphan members, containers whose
  ID + Created + nonce label do not match.
- Detached callers (double-fork + setsid, nohup/disown, cron, launchd): protection comes from the protected-supervisor
  list, not ancestry. A supervisor that has not registered itself is protected only if it is in kill.sh's ancestry.
- Residuals: no pidfd on macOS (ms-scale PID-reuse window); same-user or docker-group processes can forge entries.
