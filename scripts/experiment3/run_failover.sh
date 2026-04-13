#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
RESULTS_DIR="$ROOT_DIR/results/experiment3"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.3gw.yml"

mkdir -p "$RESULTS_DIR"

echo "============================================="
echo "  TinyTelegram Experiment 3"
echo "  Gateway Failover & Recovery Test"
echo "  $(date)"
echo "============================================="
echo ""

# Cleanup any previous runs
echo "[$(date +%H:%M:%S)] Cleaning up previous runs..."
docker-compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

# Start 3-gateway stack
echo "[$(date +%H:%M:%S)] Starting 3-gateway stack..."
docker-compose -f "$COMPOSE_FILE" up -d --build

echo "[$(date +%H:%M:%S)] Waiting for services to be ready..."
sleep 15

# Health checks
echo "[$(date +%H:%M:%S)] Running health checks..."
for i in 1 2 3; do
  HEALTH=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway${i} wget -qO- http://localhost:8080/health 2>/dev/null || echo "FAIL")
  echo "  gateway${i}: $HEALTH"
done

MSG_HEALTH=$(curl -s http://localhost:9090/health 2>/dev/null || echo "FAIL")
echo "  message-service: $MSG_HEALTH"
echo ""

# Start background metrics collection
echo "[$(date +%H:%M:%S)] Starting metrics collection..."
(
  echo "timestamp,event,connections_gw1,connections_gw2,connections_gw3" > "$RESULTS_DIR/failover_metrics.csv"
  while true; do
    TS=$(date +%s)

    # Get active connections from each gateway
    CONN1=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway1 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
            python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo "0")
    CONN2=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway2 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
            python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo "0")
    CONN3=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway3 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
            python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo "0")

    echo "${TS},running,${CONN1},${CONN2},${CONN3}" >> "$RESULTS_DIR/failover_metrics.csv"
    sleep 2
  done
) &
METRICS_PID=$!

# Start k6 load test in background
echo "[$(date +%H:%M:%S)] Starting k6 load test (50 users, 150s total)..."
(
  k6 run \
    -e WS_URL=ws://localhost:8080 \
    --out json="$RESULTS_DIR/failover_k6.json" \
    "$SCRIPT_DIR/failover_test.js" \
    > "$RESULTS_DIR/failover_k6_output.txt" 2>&1
) &
K6_PID=$!

# Wait for baseline phase (30s)
echo "[$(date +%H:%M:%S)] Establishing baseline (30s)..."
sleep 30

# Get baseline connection counts
echo "[$(date +%H:%M:%S)] Baseline established. Recording connection distribution..."
docker-compose -f "$COMPOSE_FILE" exec -T gateway1 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
  python3 -c "import sys,json; m=json.load(sys.stdin); print(f\"  gateway1: {m['active_connections']} connections\")" 2>/dev/null || echo "  gateway1: error"
docker-compose -f "$COMPOSE_FILE" exec -T gateway2 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
  python3 -c "import sys,json; m=json.load(sys.stdin); print(f\"  gateway2: {m['active_connections']} connections\")" 2>/dev/null || echo "  gateway2: error"
docker-compose -f "$COMPOSE_FILE" exec -T gateway3 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
  python3 -c "import sys,json; m=json.load(sys.stdin); print(f\"  gateway3: {m['active_connections']} connections\")" 2>/dev/null || echo "  gateway3: error"
echo ""

# Trigger failover by killing gateway1
FAILOVER_TIME=$(date +%s)
echo "[$(date +%H:%M:%S)] *** TRIGGERING FAILOVER: Killing gateway1 ***"
docker-compose -f "$COMPOSE_FILE" stop gateway1
echo "${FAILOVER_TIME},failover,0,?,?" >> "$RESULTS_DIR/failover_metrics.csv"
echo ""

# Monitor recovery
echo "[$(date +%H:%M:%S)] Monitoring recovery..."
for i in {1..12}; do
  sleep 5
  CONN2=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway2 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
          python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo "?")
  CONN3=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway3 wget -qO- http://localhost:8080/metrics 2>/dev/null | \
          python3 -c "import sys,json; print(json.load(sys.stdin).get('active_connections', 0))" 2>/dev/null || echo "?")
  echo "  [+${i}*5s] gateway2: ${CONN2}, gateway3: ${CONN3}"
done
echo ""

# Wait for k6 to finish
echo "[$(date +%H:%M:%S)] Waiting for load test to complete..."
wait $K6_PID

# Stop metrics collection
kill $METRICS_PID 2>/dev/null || true
wait $METRICS_PID 2>/dev/null || true

# Capture final state
echo "[$(date +%H:%M:%S)] Capturing final metrics..."
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
  > "$RESULTS_DIR/failover_docker_stats.txt" 2>/dev/null || true

# Cleanup
echo "[$(date +%H:%M:%S)] Stopping stack..."
docker-compose -f "$COMPOSE_FILE" down -v

echo ""
echo "============================================="
echo "  Experiment 3 Complete!"
echo "  Results: $RESULTS_DIR"
echo "============================================="
echo ""

# Display summary
if [ -f "$RESULTS_DIR/failover_k6_output.txt" ]; then
  echo "Key Findings:"
  grep -A 20 "Experiment 3:" "$RESULTS_DIR/failover_k6_output.txt" || true
fi

ls -lh "$RESULTS_DIR"
