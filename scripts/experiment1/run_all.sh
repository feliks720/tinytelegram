#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
RESULTS_DIR="$ROOT_DIR/results/experiment1"
mkdir -p "$RESULTS_DIR"

collect_metrics() {
  local NUM_GW=$1
  local OUTPUT=$2
  local COMPOSE_FILE=$3

  echo "timestamp,gateway,active_connections,goroutines,heap_alloc_mb,heap_sys_mb" > "$OUTPUT"

  while true; do
    TS=$(date +%s)
    for i in $(seq 1 $NUM_GW); do
      METRICS=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway${i} wget -qO- http://localhost:8080/metrics 2>/dev/null || true)
      if [ -n "$METRICS" ]; then
        CONNS=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo 0)
        GOROUTINES=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('goroutines', 0))" 2>/dev/null || echo 0)
        HEAP_ALLOC=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('heap_alloc_mb', 0))" 2>/dev/null || echo 0)
        HEAP_SYS=$(echo "$METRICS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('heap_sys_mb', 0))" 2>/dev/null || echo 0)
        echo "${TS},gateway${i},${CONNS},${GOROUTINES},${HEAP_ALLOC},${HEAP_SYS}" >> "$OUTPUT"
      fi
    done
    sleep 3
  done
}

run_experiment() {
  local NUM_GW=$1
  local COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.${NUM_GW}gw.yml"

  echo ""
  echo "============================================="
  echo "  Experiment 1: ${NUM_GW} Gateway(s)"
  echo "============================================="

  # Stop any previous stack
  docker-compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

  # Start stack
  echo "[$(date +%H:%M:%S)] Building and starting ${NUM_GW}-gateway stack..."
  docker-compose -f "$COMPOSE_FILE" up -d --build
  echo "[$(date +%H:%M:%S)] Waiting for services to stabilize..."
  sleep 15

  # Health check
  echo "[$(date +%H:%M:%S)] Health checks..."
  for i in $(seq 1 $NUM_GW); do
    STATUS=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway${i} wget -qO- http://localhost:8080/health 2>/dev/null || echo "FAIL")
    echo "  gateway${i}: $STATUS"
  done
  MSG_HEALTH=$(curl -s http://localhost:9090/health 2>/dev/null || echo "FAIL")
  echo "  message-service: $MSG_HEALTH"

  # Start metrics collection in background
  echo "[$(date +%H:%M:%S)] Starting metrics collection..."
  collect_metrics "$NUM_GW" "$RESULTS_DIR/${NUM_GW}gw_metrics.csv" "$COMPOSE_FILE" &
  METRICS_PID=$!

  # Run k6 load test
  echo "[$(date +%H:%M:%S)] Running k6 load test (100→500→1000→2000 VUs)..."
  k6 run \
    -e WS_URL=ws://localhost:8080 \
    --out csv="$RESULTS_DIR/${NUM_GW}gw_k6.csv" \
    "$SCRIPT_DIR/ws_load_test.js" \
    2>&1 | tee "$RESULTS_DIR/${NUM_GW}gw_k6_output.txt"

  # Stop metrics
  kill "$METRICS_PID" 2>/dev/null || true
  wait "$METRICS_PID" 2>/dev/null || true

  # Capture final docker stats
  echo "[$(date +%H:%M:%S)] Capturing final resource usage..."
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
    > "$RESULTS_DIR/${NUM_GW}gw_docker_stats.txt" 2>/dev/null || true

  # Stop stack
  echo "[$(date +%H:%M:%S)] Stopping ${NUM_GW}-gateway stack..."
  docker-compose -f "$COMPOSE_FILE" down -v

  echo "[$(date +%H:%M:%S)] Done: ${NUM_GW}-gateway experiment complete."
}

echo "============================================="
echo "  TinyTelegram Experiment 1"
echo "  Gateway Horizontal Scaling (1→3→5)"
echo "  $(date)"
echo "============================================="

for GW_COUNT in 1 3 5; do
  run_experiment $GW_COUNT
  # Brief pause between experiments
  sleep 5
done

echo ""
echo "============================================="
echo "  All experiments complete!"
echo "  Results in: $RESULTS_DIR"
echo "============================================="
ls -la "$RESULTS_DIR"
