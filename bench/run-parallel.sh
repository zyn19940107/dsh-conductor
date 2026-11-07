#!/usr/bin/env bash
# Fill in whatever is still missing: 5 runs per condition per task.
# Light tasks first (they finish fast and free a slot), heavy ones last.
# Same task + same condition is serial (the workspace is shared); tasks run in
# parallel, four at a time so the API is not flooded.
set -u
cd "$(dirname "$0")/.." || exit 1

TASKS=(coverage review humeval humeval-hard quixbugs panel lhtb-commit0 lhtb-matpower lhtb-2048 lhtb-nbody)
MAX_JOBS=4

run_task() {
  local task=$1
  local start
  start=$(date +%H:%M)
  for i in 1 2 3 4 5; do
    for cond in off on; do
      local f="bench/results/$task-$cond-$i.json"
      [ -f "$f" ] && continue
      node bench/run-one.mjs "$task" "$cond" "$i" >/dev/null 2>&1
      if [ -f "$f" ]; then
        echo "$(date +%H:%M) $task $cond $i 完成"
      else
        echo "$(date +%H:%M) $task $cond $i 失败"
      fi
    done
  done
  echo "[$task] 收工（$start → $(date +%H:%M)）"
}

active=0
for task in "${TASKS[@]}"; do
  run_task "$task" &
  active=$((active + 1))
  if [ "$active" -ge "$MAX_JOBS" ]; then
    wait -n
    active=$((active - 1))
  fi
done
wait
echo "全部完成 $(date +%H:%M)"
