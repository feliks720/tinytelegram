#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
RESULTS_DIR="$ROOT_DIR/results/experiment4"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

mkdir -p "$RESULTS_DIR"

echo "============================================="
echo "  TinyTelegram Experiment 4"
echo "  Consistency Validation & PTS Ordering"
echo "  $(date)"
echo "============================================="
echo ""

# Cleanup any previous runs
echo "[$(date +%H:%M:%S)] Cleaning up previous runs..."
docker-compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

# Start stack
echo "[$(date +%H:%M:%S)] Starting stack..."
docker-compose -f "$COMPOSE_FILE" up -d --build

echo "[$(date +%H:%M:%S)] Waiting for services to be ready..."
sleep 15

# Health checks
echo "[$(date +%H:%M:%S)] Running health checks..."
for i in 1 2; do
  HEALTH=$(docker-compose -f "$COMPOSE_FILE" exec -T gateway${i} wget -qO- http://localhost:8080/health 2>/dev/null || echo "FAIL")
  echo "  gateway${i}: $HEALTH"
done

MSG_HEALTH=$(curl -s http://localhost:9090/health 2>/dev/null || echo "FAIL")
echo "  message-service: $MSG_HEALTH"

# Check Redis and Postgres
REDIS_PING=$(docker-compose -f "$COMPOSE_FILE" exec -T redis redis-cli PING 2>/dev/null || echo "FAIL")
echo "  redis: $REDIS_PING"

PG_READY=$(docker-compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U tt_user 2>/dev/null || echo "FAIL")
echo "  postgres: $PG_READY"
echo ""

# Start background metrics collection
echo "[$(date +%H:%M:%S)] Starting PTS monitoring..."
(
  echo "timestamp,phase,redis_pts_user1,redis_pts_user2,pg_message_count" > "$RESULTS_DIR/consistency_metrics.csv"
  while true; do
    TS=$(date +%s)
    PHASE="running"

    # Sample PTS from Redis for a few test users
    PTS1=$(docker-compose -f "$COMPOSE_FILE" exec -T redis redis-cli GET "user:user_consist_1:pts" 2>/dev/null || echo "0")
    PTS2=$(docker-compose -f "$COMPOSE_FILE" exec -T redis redis-cli GET "user:user_consist_2:pts" 2>/dev/null || echo "0")

    # Count messages in Postgres
    MSG_COUNT=$(docker-compose -f "$COMPOSE_FILE" exec -T postgres psql -U tt_user -d tinytelegram -t -c "SELECT COUNT(*) FROM messages;" 2>/dev/null | tr -d ' ' || echo "0")

    echo "${TS},${PHASE},${PTS1},${PTS2},${MSG_COUNT}" >> "$RESULTS_DIR/consistency_metrics.csv"
    sleep 3
  done
) &
METRICS_PID=$!

# Start k6 load test in background
echo "[$(date +%H:%M:%S)] Starting consistency test (phase 1: 90s normal operation)..."
(
  k6 run \
    -e WS_URL=ws://localhost:8080 \
    --out json="$RESULTS_DIR/consistency_k6.json" \
    "$SCRIPT_DIR/consistency_test.js" \
    > "$RESULTS_DIR/consistency_k6_output.txt" 2>&1
) &
K6_PID=$!

# Wait for normal phase to complete
echo "[$(date +%H:%M:%S)] Phase 1: Normal operation (90s)..."
sleep 90

# Simulate crash scenario: restart message-service to create potential PTS/gRPC gap
echo ""
echo "[$(date +%H:%M:%S)] *** SIMULATING CRASH: Restarting message-service ***"
echo "[$(date +%H:%M:%S)] This tests whether PTS gaps are properly detected..."
docker-compose -f "$COMPOSE_FILE" restart message-service
echo "timestamp,crash,?,?,?" >> "$RESULTS_DIR/consistency_metrics.csv"

echo "[$(date +%H:%M:%S)] Waiting for message-service recovery..."
sleep 10

# Check if service recovered
MSG_HEALTH=$(curl -s http://localhost:9090/health 2>/dev/null || echo "FAIL")
echo "  message-service after restart: $MSG_HEALTH"
echo ""

# Phase 2 continues automatically in k6 (post-crash validation)
echo "[$(date +%H:%M:%S)] Phase 2: Post-crash validation (60s)..."
echo "[$(date +%H:%M:%S)] Waiting for load test to complete..."

# Wait for k6 to finish
wait $K6_PID

# Stop metrics collection
kill $METRICS_PID 2>/dev/null || true
wait $METRICS_PID 2>/dev/null || true

echo ""
echo "[$(date +%H:%M:%S)] Analyzing PTS consistency..."

# Query Postgres for PTS ordering validation
echo "[$(date +%H:%M:%S)] Checking Postgres message ordering..."
docker-compose -f "$COMPOSE_FILE" exec -T postgres psql -U tt_user -d tinytelegram -c \
  "SELECT
    sender_id,
    COUNT(*) as total_messages,
    MIN(sender_pts) as min_pts,
    MAX(sender_pts) as max_pts,
    MAX(sender_pts) - MIN(sender_pts) + 1 as expected_count,
    CASE
      WHEN COUNT(*) = MAX(sender_pts) - MIN(sender_pts) + 1 THEN 'CONSISTENT'
      ELSE 'GAPS EXIST'
    END as status
   FROM messages
   WHERE sender_id LIKE 'user_consist_%'
   GROUP BY sender_id
   ORDER BY sender_id
   LIMIT 10;" \
  > "$RESULTS_DIR/pts_ordering_analysis.txt" 2>&1 || true

cat "$RESULTS_DIR/pts_ordering_analysis.txt"

# Capture final state
echo ""
echo "[$(date +%H:%M:%S)] Capturing final metrics..."
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
  > "$RESULTS_DIR/consistency_docker_stats.txt" 2>/dev/null || true

# Cleanup
echo "[$(date +%H:%M:%S)] Stopping stack..."
docker-compose -f "$COMPOSE_FILE" down -v

echo ""
echo "============================================="
echo "  Experiment 4 Complete!"
echo "  Results: $RESULTS_DIR"
echo "============================================="
echo ""

# Display summary
if [ -f "$RESULTS_DIR/consistency_summary.txt" ]; then
  cat "$RESULTS_DIR/consistency_summary.txt"
else
  echo "Checking k6 output..."
  tail -50 "$RESULTS_DIR/consistency_k6_output.txt" || true
fi

echo ""
ls -lh "$RESULTS_DIR"
