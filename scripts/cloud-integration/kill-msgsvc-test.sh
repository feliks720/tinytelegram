#!/usr/bin/env bash
# Phase 1 exit criterion (b): mid-run message-service kill test.
#
# Runs gateway + msgsvc locally (pointed at cloud RDS+ElastiCache via the SSM
# bastion tunnel on 127.0.0.1:15432 / :16379), runs k6 at 50 msg/s for 3 min,
# kills msgsvc at 60s, immediately relaunches, and reports downtime + any
# PTS-duplicate occurrences.
#
# Preconditions: start-bastion-tunnel.sh (or equivalent) must already be
# running in another shell.
set -uo pipefail  # NOTE: no -e — we want to continue past individual failures

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${AWS_PROFILE:-myisb_IsbUsersPS-557270420767}"
REGION="${AWS_REGION:-us-east-1}"
TMPDIR="${TMPDIR:-/tmp}"

log() { echo "[$(date +%T)] $*"; }

REDIS_TOKEN=$(aws secretsmanager get-secret-value --secret-id tinytelegram/redis --region "$REGION" --query SecretString --output text --profile "$PROFILE" | python -c "import json,sys; print(json.load(sys.stdin)['token'])")
DB_PASS=$(aws secretsmanager get-secret-value --secret-id tinytelegram/db --region "$REGION" --query SecretString --output text --profile "$PROFILE" | python -c "import json,sys; print(json.load(sys.stdin)['password'])")

# SSM tunnels bind IPv4 only; 'localhost' resolves to ::1 on Windows and fails.
export REDIS_ADDR="127.0.0.1:16379"
export REDIS_AUTH="$REDIS_TOKEN"
export REDIS_TLS="true"
export REDIS_TLS_INSECURE="true"
export POSTGRES_DSN="postgres://tt_user:${DB_PASS}@127.0.0.1:15432/tinytelegram?sslmode=require"

# Grab a scalar from dbcheck output by key.
dbcheck_count() {
    (cd "$ROOT/message-service" && POSTGRES_DSN="$POSTGRES_DSN" go run ./cmd/dbcheck 2>/dev/null) \
        | sed -n 's/^=== total_messages: \([0-9]*\) ===/\1/p' | head -1
}
dbcheck_full() {
    (cd "$ROOT/message-service" && POSTGRES_DSN="$POSTGRES_DSN" go run ./cmd/dbcheck 2>/dev/null)
}

# Pre-build binaries for fast restart.
log "building binaries..."
(cd "$ROOT/message-service" && go build -o "$TMPDIR/tt-msgsvc.exe" .) || { echo "BUILD msgsvc FAILED"; exit 1; }
(cd "$ROOT/gateway" && go build -o "$TMPDIR/tt-gw.exe" .) || { echo "BUILD gw FAILED"; exit 1; }

cleanup() {
    log "cleanup..."
    taskkill -F -IM tt-msgsvc.exe > /dev/null 2>&1
    taskkill -F -IM tt-gw.exe     > /dev/null 2>&1
    taskkill -F -IM k6.exe        > /dev/null 2>&1
}
trap cleanup EXIT

# Start msgsvc
PORT=9090 GRPC_PORT=5050 "$TMPDIR/tt-msgsvc.exe" > "$TMPDIR/tt-msgsvc.log" 2>&1 &
sleep 3
for i in $(seq 1 20); do
    curl -sf http://127.0.0.1:9090/health > /dev/null 2>&1 && break
    sleep 0.5
done
log "msgsvc up"

# Start gateway
PORT=8080 GRPC_PORT=9000 \
GATEWAY_ADDR=127.0.0.1:8080 GATEWAY_GRPC_ADDR=127.0.0.1:9000 \
MSG_SERVICE_ADDR=127.0.0.1:5050 \
"$TMPDIR/tt-gw.exe" > "$TMPDIR/tt-gw.log" 2>&1 &
sleep 2
for i in $(seq 1 20); do
    curl -sf http://127.0.0.1:8080/health > /dev/null 2>&1 && break
    sleep 0.5
done
log "gateway up"

BASELINE="$(dbcheck_count)"
BASELINE="${BASELINE:-0}"
log "baseline messages: $BASELINE"

# Start k6 at 50 msg/s for 3 minutes
log "starting k6 (3 min at 50 msg/s target)..."
GATEWAY="ws://127.0.0.1:8080/ws" DURATION=3m DURATION_MS=180000 \
    k6 run "$ROOT/scripts/cloud-integration/k6-integration-check.js" > "$TMPDIR/tt-k6.log" 2>&1 &
K6_PID=$!

# Wait 60s, then SIGKILL msgsvc by image name and relaunch.
sleep 60
log "killing msgsvc..."
KILL_TS=$(date +%s)
taskkill -F -IM tt-msgsvc.exe > /dev/null 2>&1
log "taskkill returned $?"

PORT=9090 GRPC_PORT=5050 "$TMPDIR/tt-msgsvc.exe" >> "$TMPDIR/tt-msgsvc.log" 2>&1 &
log "relaunched msgsvc, waiting for /health..."

for i in $(seq 1 200); do
    curl -sf http://127.0.0.1:9090/health > /dev/null 2>&1 && break
    sleep 0.1
done
BACK_TS=$(date +%s)
DOWNTIME=$((BACK_TS - KILL_TS))
log "msgsvc back after ${DOWNTIME}s"

# Let k6 finish the remaining ~2 minutes
wait "$K6_PID" > /dev/null 2>&1
log "k6 finished"

# Final verification
echo ""
echo "=== DB verification ==="
VERIFY_OUT="$(dbcheck_full)"
echo "$VERIFY_OUT"
FINAL="$(echo "$VERIFY_OUT" | sed -n 's/^=== total_messages: \([0-9]*\) ===/\1/p' | head -1)"
FINAL="${FINAL:-0}"
ADDED=$((FINAL - BASELINE))

DUP_RCV="$(echo "$VERIFY_OUT" | awk '/^=== duplicate receiver_pts/,/^=== duplicate sender_pts/' | grep -c '^  \[')"
DUP_SND="$(echo "$VERIFY_OUT" | awk '/^=== duplicate sender_pts/,/^=== receiver_pts gaps/' | grep -c '^  \[')"

echo ""
echo "=== Summary ==="
printf "  baseline       = %s\n" "$BASELINE"
printf "  final          = %s\n" "$FINAL"
printf "  messages added = %s\n" "$ADDED"
printf "  dup receiver   = %s\n" "$DUP_RCV"
printf "  dup sender     = %s\n" "$DUP_SND"
printf "  downtime       = %ss\n" "$DOWNTIME"

echo ""
if [ "$DOWNTIME" -le 10 ] && [ "$DUP_RCV" = "0" ] && [ "$DUP_SND" = "0" ]; then
    echo "PASS: downtime ${DOWNTIME}s ≤ 10s; 0 PTS duplicates"
    exit 0
else
    echo "FAIL: downtime=${DOWNTIME}s, dup_rcv=$DUP_RCV, dup_snd=$DUP_SND"
    exit 1
fi
