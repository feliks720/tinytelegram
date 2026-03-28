#!/bin/bash
set -euo pipefail

NUM_GW=${1:-3}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
RESULTS_DIR="$ROOT_DIR/results/experiment1"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.${NUM_GW}gw.yml"

mkdir -p "$RESULTS_DIR"

echo "=== Experiment 1: ${NUM_GW} gateways ==="
echo "Starting stack with ${NUM_GW} gateways..."
docker compose -f "$COMPOSE_FILE" up -d --build
sleep 10

for i in $(seq 1 $NUM_GW); do
  echo "Checking gateway${i}..."
  docker compose -f "$COMPOSE_FILE" exec -T gateway${i} wget -qO- http://localhost:8080/health
  echo ""
done

echo "Starting metrics collection..."
"$SCRIPT_DIR/collect_metrics.sh" "$NUM_GW" 420 "$RESULTS_DIR/${NUM_GW}gw_metrics.csv" "$COMPOSE_FILE" &
METRICS_PID=$!

echo "Running k6 load test..."
(
  cd "$SCRIPT_DIR"
  k6 run --out csv="$RESULTS_DIR/${NUM_GW}gw_k6.csv" ws_load_test.js
)

kill "$METRICS_PID" 2>/dev/null || true

echo "Stopping stack..."
docker compose -f "$COMPOSE_FILE" down -v

echo "=== Done: results in ${RESULTS_DIR} ==="
