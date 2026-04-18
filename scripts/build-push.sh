#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG="${1:-$(git rev-parse --short HEAD)}"

# Dockerfiles COPY go.mod/go.sum from the build context root, and those files
# live inside each service directory (not at the repo root), so the build
# context must be the service directory — not the repo root.

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

docker build --platform linux/amd64 -t "$REGISTRY/tt-gw:$TAG" -f gateway/Dockerfile gateway
docker push "$REGISTRY/tt-gw:$TAG"

docker build --platform linux/amd64 -t "$REGISTRY/tt-msgsvc:$TAG" -f message-service/Dockerfile message-service
docker push "$REGISTRY/tt-msgsvc:$TAG"

echo "Pushed tag: $TAG"
