# Phase 2 + 3 demo validation — 2026-04-18 → 2026-04-19

This run validates the **Phase 2 (Compute)** and **Phase 3 (Edge)** exit criteria from the spec §8 in *demo-only* mode. The rigorous k6 load and ECS task-kill experiments (Plan 2 Tasks 10–11) are intentionally deferred to Phase 4 along with Exp1/3/5/6; this document records only the functional validation that a distributed deployment actually works end-to-end.

**What "demo-only" means here:** two humans on two different laptops open a public CloudFront URL, log in as different users, send messages, and both bubbles render correctly. No load generator, no induced failures, no latency/throughput measurement.

---

## Environment under test

| Component | Location | Notes |
|---|---|---|
| `web-client` static assets | S3 `ttedgestack-webbucket12880f5b-ya8jniclvaic` behind CloudFront | served via `https://d1ji1p758sdqkv.cloudfront.net/` |
| `gateway` | 2 Fargate tasks across 2 AZs, behind internal ALB | CloudFront `ws*` behavior forwards WebSocket upgrade to ALB |
| `message-service` | 1 Fargate task, CloudMap DNS `msgsvc.tt.local:5050` | gRPC; gateways resolve via VPC DNS |
| RDS PostgreSQL 16.3 | `db.m6g.large`, Multi-AZ | same instance as Phase 1 (`TtDataStack`) |
| ElastiCache Redis 7.1 | `cache.m6g.large`, Multi-AZ, TLS + AUTH | same instance as Phase 1 (`TtDataStack`) |
| Region / AZs | `us-east-1a` + `us-east-1b` | VPC `vpc-0a883bd3d1ff648a7` |
| AWS profile | `myisb_IsbUsersPS-557270420767` | account 557270420767 |
| Stacks deployed | `TtVpcStack`, `TtDataStack`, `TtComputeStack`, `TtEdgeStack` | all `CREATE_COMPLETE` / `UPDATE_COMPLETE` |

Plan 2 commit range on branch `claude/plan2-compute-edge`:

```
ee2e473 infra-cdk: scaffold compute + edge stacks
b1e51a3 infra-cdk: ECR repos + image build/push script
d2be614 gateway: derive self-id and grpc addr from ECS task metadata
bb396ee infra-cdk: ECS cluster + task roles + log groups
5f37061 infra-cdk: message-service Fargate task def + service with CloudMap
eca6530 infra-cdk: gateway Fargate service + ALB with WebSocket listener
b3195e5 infra-cdk: edge stack — S3 bucket + CloudFront with dual origins
5bba722 web-client: default WS URL to location.host; add S3 deploy script
5233570 gateway: publish resolved ECS self-identity into os.Environ
5df79c6 web-client: reconcile optimistic temp message with server ack
```

---

## What we proved

### (a) Phase 2 exit — cross-AZ messaging via Fargate

> Spec §8 Phase 2: *"Two browsers connected via port-forwarded ALB (or direct task IP) can message across AZs"*

Verified via the `scripts/ws-2user.js` local test driven against the public CloudFront URL (acts as a headless stand-in for two browsers):

```
[alice recv] {"message_id":"b9c89b5d-f3f0-49fd-bdc7-def4100b104e",
              "sender_pts":11,"type":"ack"}
[bob   recv] {"id":"b9c89b5d-f3f0-49fd-bdc7-def4100b104e",
              "message":{"sender_id":"alice","receiver_id":"bob",
                         "content":"hello bob, cross-gateway test",...},
              "receiver_pts":13,"sender_pts":11,...}
```

Matching `/tt/gateway` CloudWatch lines for a cross-gateway session:

```
2026/04/19 02:47:34 ECS self-identity: id=2294233a grpc=10.20.8.188:9000
2026/04/19 02:47:55 ECS self-identity: id=1898cca7 grpc=10.20.7.107:9000
2026/04/19 02:53:00 User bob   connected to gateway 1898cca7
2026/04/19 02:53:04 User alice connected to gateway 2294233a
```

Two users landed on two different gateway tasks in two different AZs, and alice→bob delivery succeeded via gateway-to-gateway gRPC peer call.

### (b) Phase 3 exit — public URL works end-to-end from a fresh browser

> Spec §8 Phase 3: *"Public URL works end-to-end from a fresh browser with no dev tools"*

Confirmed by the human operator on 2026-04-19: alice and bob logged in on two separate laptops at `https://d1ji1p758sdqkv.cloudfront.net/`, exchanged messages, and both sides rendered messages with monotonically incrementing PTS. The bubble "Sending…" state cleared on ack for both sender and receiver.

---

## Bugs found and fixed during validation

Three bugs surfaced during demo testing that were not covered by unit or integration tests. All are now fixed on this branch.

### B1 — Gateway self-identity never reached the WebSocket handler

**Symptom:** Cross-gateway messages silently dropped. `User <x> connected to gateway ` log line (trailing space — empty ID).

**Root cause:** `gateway/main.go` resolved the task's IP from ECS task metadata v4 into local variables but did not publish them into `os.Environ`. The downstream handler at [gateway/handler/websocket.go:46–47](../../gateway/handler/websocket.go) reads `GATEWAY_ADDR` / `GATEWAY_GRPC_ADDR` fresh from the environment on each WebSocket upgrade — it got empty strings, registered each user's presence under `""`, and `store.GetUserGateway` returned `""` so the peer-delivery branch was skipped (line 130 `continue`).

**Fix (commit `5233570`):**

```go
gatewayAddr, grpcAddr = id, addr
os.Setenv("GATEWAY_ADDR", gatewayAddr)
os.Setenv("GATEWAY_GRPC_ADDR", grpcAddr)
log.Printf("ECS self-identity: id=%s grpc=%s", gatewayAddr, grpcAddr)
```

Evidence of fix in `/tt/gateway`: `User alice connected to gateway 2294233a` now carries a real task-suffix ID.

### B2 — Optimistic send bubble stuck at "Sending…"

**Symptom:** Sender's own message stays grey with "Sending…" forever, even though the receiver gets it fine.

**Root cause:** The web client renders an optimistic bubble with a `temp_*` id as soon as the user clicks Send, and was supposed to reconcile it with the server-assigned UUID when the `{type:"ack"}` frame arrived. The pre-fix `handleAck` only advanced PTS — it never touched the temp bubble. Compounding it: because acks for a single WebSocket arrive in send-order, we needed a FIFO queue of temp ids to know which one each ack resolves.

**Fix (commit `5df79c6`):** added `pendingAcks` queue in [web-client/public/app.js](../../web-client/public/app.js); each send pushes a tempId, each ack shifts the head and replaces that bubble with the real message id + PTS.

### B3 — ECS TaskExecRole missing `logs:CreateLogGroup`

**Symptom:** Any `aws ecs run-task` using a log group that doesn't exist yet fails with `ResourceInitializationError … AccessDenied on logs:CreateLogGroup`.

**Not a production bug** — our long-lived services use pre-created log groups declared in CDK, so this only bit during the ad-hoc Redis/DB wipe task (see below). Worked around by `aws logs create-log-group` before `run-task`. Documented here so future one-offs don't re-learn it.

---

## Redis + Postgres wipe (operational note)

Mid-validation we wiped both data stores to reset PTS counters accumulated during the B1 / B2 debugging. Since `TtBastionStack` was destroyed at the end of Phase 1, the wipe path went through a one-shot Fargate task in the private subnet with the AppSg attached:

```
--- redis FLUSHALL ---
OK
--- psql TRUNCATE messages ---
TRUNCATE TABLE
 count | 0
--- done ---
```

The wipe task def was transient and contained secrets inline, so it was not committed. If a future operator needs the same operation, register an equivalent task def with a `postgres:16-alpine` image + `apk add redis` + credentials injected from `tinytelegram/db` and `tinytelegram/redis` Secrets Manager entries, run it on a private subnet with `sg-0a66092441651a404` (AppSg).

---

## Deferred to Phase 4

None of the below were attempted in this validation. They belong to Plan 2 Tasks 10–11 and spec §6 experiments:

- **k6 10-minute load** against the public URL (Exp1-style throughput + 0-duplicate check in-VPC).
- **ECS task-kill** (`aws ecs stop-task` on a running gateway; verify < 10 s reconnect, no PTS duplicates).
- **Exp1 / Exp3 / Exp5 / Exp6** — the scored cloud experiments. Each produces its own `results/expN_cloud/` folder per §8 Phase 4.

---

## Reproduction

```bash
# 1. Deploy
cd infra-cdk
eval "$(aws configure export-credentials --profile myisb_IsbUsersPS-557270420767 --format env)"
export AWS_REGION=us-east-1
npx cdk deploy --all --require-approval never

# 2. Push images and force a fresh ECS deployment
bash ../scripts/push-images.sh
aws ecs update-service --cluster tt-cluster \
  --service <GwService> --force-new-deployment
aws ecs update-service --cluster tt-cluster \
  --service <MsgsvcService> --force-new-deployment

# 3. Upload web client
bash ../scripts/deploy-web.sh

# 4. Open https://d1ji1p758sdqkv.cloudfront.net/ on two laptops,
#    log in as alice and bob, send messages both directions.
```

Service ARNs (current deployment):

- Gateway: `TtComputeStack-GwService30FF6ACF-dkOybWPAdenT` (desired=2, running=2)
- Msgsvc: `TtComputeStack-MsgsvcServiceF88EF1E2-AL762Axbfoqh` (desired=1, running=1)
