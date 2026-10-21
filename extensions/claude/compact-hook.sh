#!/bin/bash
# Claude SessionStart hook after a compaction: a coordinator gets its protocol back.
cat >/dev/null
exec "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/lib/coordinator-reminder.sh"
