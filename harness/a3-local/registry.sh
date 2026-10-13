# Shared helpers (sourced). Registry of runs this tooling started; kill.sh acts only on entries here.
: ${A3_REGISTRY:=$HOME/.rove-a3/registry}
: ${A3_KILL_LOG:=$HOME/.rove-a3/kill.log}
a3_init() { umask 077; mkdir -p -m 700 "$A3_REGISTRY" "${A3_KILL_LOG:h}"; }
a3_now() { perl -MPOSIX=strftime -MTime::HiRes=time -e '$t=time; printf "%s.%03d", strftime("%Y-%m-%dT%H:%M:%S%z", localtime($t)), ($t-int($t))*1000'; }
# Append before acting so the record survives if the actor is killed next.
a3_log() { a3_init; print -r -- "$(a3_now) $*" >> "$A3_KILL_LOG"; }
