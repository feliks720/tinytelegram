#!/usr/bin/env bash
# Open SSM port-forwards from local to cloud RDS + ElastiCache primary via bastion.
# Usage: source this file's lower half or run it in a dedicated terminal.
set -euo pipefail

PROFILE="${AWS_PROFILE:-myisb_IsbUsersPS-557270420767}"
REGION="${AWS_REGION:-us-east-1}"

BASTION_ID="$(aws cloudformation describe-stacks \
  --stack-name TtBastionStack --profile "$PROFILE" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`BastionInstanceId`].OutputValue' --output text)"

DB_ENDPOINT="$(aws cloudformation describe-stacks \
  --stack-name TtDataStack --profile "$PROFILE" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`DbEndpoint`].OutputValue' --output text)"

REDIS_ENDPOINT="$(aws cloudformation describe-stacks \
  --stack-name TtDataStack --profile "$PROFILE" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`RedisPrimaryEndpoint`].OutputValue' --output text)"

echo "Bastion: $BASTION_ID"
echo "RDS:     $DB_ENDPOINT → localhost:15432"
echo "Redis:   $REDIS_ENDPOINT → localhost:16379"
echo "Starting SSM tunnels (Ctrl-C to stop)..."

aws ssm start-session --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_ENDPOINT\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"15432\"]}" \
  --profile "$PROFILE" --region "$REGION" &
RDS_TUNNEL_PID=$!

aws ssm start-session --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$REDIS_ENDPOINT\"],\"portNumber\":[\"6379\"],\"localPortNumber\":[\"16379\"]}" \
  --profile "$PROFILE" --region "$REGION" &
REDIS_TUNNEL_PID=$!

trap "kill $RDS_TUNNEL_PID $REDIS_TUNNEL_PID 2>/dev/null || true" EXIT
wait
