#!/usr/bin/env bash
# Run every task's five pairs, five tasks at a time.
# Same task + same condition must be serial (the workspace is shared), so each
# task owns one slot and runs its ten runs in order; tasks run in parallel.
set -u
cd "$(dirname "$0")/.." || exit 1

TASKS=(lhtb-commit0 lhtb-nbody lhtb-matpower panel lhtb-2048 quixbugs coverage humeval review humeval-hard)
MAX_JOBS=5

run_task() {
  local task=$1
  local slot=$2
  local start
  start=$(date +%H:%M)
  for i in 1 2 3 4 5; do
    for cond in off on; do
      local f="bench/results/$task-$cond-$i.json"
      [ -f "$f" ] && continue
      if ! node bench/run-one.mjs "$task" "$cond" "$i" >/dev/null 2>&1; then
        echo "[$slot] $task $cond $i 失败"
      fi
    done
  done
  echo "[$slot] $task 完成（$start → $(date +%H:%M)）"
}

active=0
for task in "${TASKS[@]}"; do
  run_task "$task" "$task" &
  active=$((active + 1))
  if [ "$active" -ge "$MAX_JOBS" ]; then
    wait -n
    active=$((active - 1))
  fi
done
wait
echo "全部完成 $(date +%H:%M)"
