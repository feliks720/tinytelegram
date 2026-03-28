#!/bin/bash
set -euo pipefail

NUM_GW=${1:-2}
DURATION=${2:-360}
OUTPUT=${3:-metrics.csv}
COMPOSE_FILE=${4:-docker-compose.yml}

echo "timestamp,gateway,active_connections,goroutines,heap_alloc_mb,heap_sys_mb" > "$OUTPUT"

END=$((SECONDS + DURATION))

while [ $SECONDS -lt $END ]; do
  TS=$(date +%s)
  for i in $(seq 1 $NUM_GW); do
    METRICS=$(docker compose -f "$COMPOSE_FILE" exec -T gateway${i} wget -qO- http://localhost:8080/metrics 2>/dev/null || true)
    if [ -n "$METRICS" ]; then
      CONNS=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo 0)
      GOROUTINES=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('goroutines', 0))" 2>/dev/null || echo 0)
      HEAP_ALLOC=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('heap_alloc_mb', 0))" 2>/dev/null || echo 0)
      HEAP_SYS=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('heap_sys_mb', 0))" 2>/dev/null || echo 0)
      echo "${TS},gateway${i},${CONNS},${GOROUTINES},${HEAP_ALLOC},${HEAP_SYS}" >> "$OUTPUT"
    fi
  done
  sleep 2
done

echo "Metrics collection complete: $OUTPUT"
