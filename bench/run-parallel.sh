#!/usr/bin/env bash
# Re-measure every task, both conditions, five runs each.
#
# The unit of work is one (task, condition) pair, not one task: the two arms use
# separate workspaces, so they do not contend, and splitting them keeps every
# slot busy. What must stay serial is runs inside a pair — they share a
# workspace — and that is exactly what a pair job is.
#
# Light pairs first (they finish fast and free a slot), heavy ones last.
set -u
cd "$(dirname "$0")/.." || exit 1

MAX_JOBS=8

# Light first, then the two long ones. Each entry becomes two jobs (off and on).
LIGHT=(coverage review quixbugs humeval humeval-hard)
HEAVY=(panel lhtb-matpower lhtb-nbody)

run_pair() {
  local task=$1
  local cond=$2
  local start
  start=$(date +%H:%M)
  local done=0
  for i in 1 2 3 4 5; do
    local f="bench/results/$task-$cond-$i.json"
    if [ -f "$f" ]; then
      done=$((done + 1))
      continue
    fi
    node bench/run-one.mjs "$task" "$cond" "$i" >/dev/null 2>&1
    if [ -f "$f" ]; then
      done=$((done + 1))
      echo "$(date +%H:%M) $task $cond $i 完成（$done/5）"
    else
      echo "$(date +%H:%M) $task $cond $i 失败（$done/5）"
    fi
  done
  echo "[$task $cond] 收工 $start → $(date +%H:%M)（$done/5）"
}

active=0
for task in "${LIGHT[@]}" "${HEAVY[@]}"; do
  for cond in off on; do
    run_pair "$task" "$cond" &
    active=$((active + 1))
    if [ "$active" -ge "$MAX_JOBS" ]; then
      wait -n
      active=$((active - 1))
    fi
  done
done
wait
echo "全部完成 $(date +%H:%M)"