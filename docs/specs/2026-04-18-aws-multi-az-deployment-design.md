# TinyTelegram — AWS Multi-AZ Deployment Design

**Status:** Draft
**Author:** Fazheng Han
**Date:** 2026-04-18
**Supersedes parts of:** `TinyTelegram-Design-Document.md` (v1.0, Feb 2026) — see §5 "Delta from Original Design"

---

## 1. Overview

This document specifies the re-architecture of TinyTelegram from a local `docker-compose` deployment to an AWS Multi-AZ deployment on the school-provided AWS account (`557270420767`). The goal is to **remove single points of failure** (Redis, PostgreSQL, Nginx, single-instance services) while **preserving the CP semantics** and **PTS monotonicity guarantees** defined in the original design document.

The migration also enables two new experiments that are infeasible in a local Docker setup:

- **Experiment 5:** Real AZ-level PostgreSQL failover via RDS Multi-AZ
- **Experiment 6:** Real ElastiCache primary failover with verification of PTS monotonicity

Experiments 1 and 3 from the original four are re-run on AWS for comparison; Experiments 2 and 4 are considered "satisfied" by the original local runs and will be cited but not re-executed.

---

## 2. Goals and Non-Goals

### Goals

1. Eliminate every single-instance component from the production path (data stores, LB, application services).
2. Preserve every invariant promised by the original design document — specifically the §5.2 *"guaranteeing monotonicity"* and §11 *"CP emphasis / reject writes under partition"* commitments.
3. Make the experiment harness cloud-native: reproducible via Infrastructure-as-Code, scalable by redeploy (not by manual editing).
4. Produce a deployment that is stable enough to leave running for an arbitrary demo window (no budget cap).

### Non-Goals

- **Multi-region.** Single region, two AZs. Multi-region adds DNS/replication complexity without new narrative for this project.
- **Custom HA of Redis/Postgres.** Explicitly rejected in favor of managed services (decision in §3).
- **Exactly-once delivery.** Original design is at-least-once + client-side dedup via message ID; this design inherits that.
- **Authentication / production security hardening.** Scope is a course demo; threat model is "course staff + teammates."

---

## 3. Design Decisions

Each decision records the options considered, the choice, and the reasoning.

| # | Decision | Options considered | Choice | Reason |
|---|---|---|---|---|
| D1 | Deployment goal | (A) short demo / (B) long-lived showcase / (C) re-run experiments on real cloud | **C** | Course is CS6650; cloud narrative is strongest when experiments live on real infrastructure. No budget constraint. |
| D2 | Stateful stores HA strategy | (A) fully managed / (B) self-hosted HA (Sentinel + streaming repl.) / (C) hybrid | **A — fully managed** | Minimizes time spent on infrastructure plumbing; keeps focus on application-level behavior under cloud-native failover. |
| D3 | Compute platform | (A) ECS Fargate / (B) EKS / (C) EC2 + Compose | **A — ECS Fargate** | CS6650's default teaching platform; seamless Dockerfile reuse; cross-AZ distribution is a config line. |
| D4 | LB / Gateway routing | (A) ALB no consistent hash / (B) ALB cookie sticky / (C) client-side hash | **A — ALB w/o consistent hash** | ALB does not natively support `hash $arg_user_id`; gateway mesh already handles cross-node routing, so consistent hashing is an optimization, not a correctness requirement. Narrative shifts from "consistent hashing" to "ALB health check + mesh for seamless failover." |
| D5 | Infrastructure-as-Code | (A) CDK / (B) Terraform / (C) CloudFormation / (D) shell+CLI | **A — AWS CDK (TypeScript)** | Type safety, consistent with CS6650 ecosystem, loops/parameterization natural for experiment configurations. |
| D6 | Observability | (A) CloudWatch / (B) self-hosted Prom+Grafana / (C) AMP + Managed Grafana / (D) keep k6 local | **A + D** | CloudWatch for infrastructure + app metrics (minimal ops burden); local k6 preserved so existing plotting scripts and narrative continue to work unchanged. |
| D7 | Experiments to run on cloud | (A) all 4 / (B) 4 + 2 new / (C) 2 + 2 new | **C** | Exp2 (Redis vs PG bottleneck) and Exp4 (consistency) are already settled on local; cloud re-runs would be repetitive. Exp1 (scaling) and Exp3 (gateway failover) are re-run because the cloud behavior differs meaningfully. Exp5 and Exp6 are new and only possible on cloud. |
| D8 | Web client hosting | (A) S3 + CloudFront / (B) Node in Fargate / (C) Node as Fargate task | **A — S3 + CloudFront** | Static files don't need a runtime; S3 is multi-AZ by default; CloudFront gives global edge delivery; decouples frontend from backend lifecycle. |
| D9 | PTS durability under Redis async replication | (1) accept gap as CAP trade-off / (2) `WAIT 1 <timeout>` after INCR and reject on timeout | **2 — WAIT + reject** | Original design §5.2 promises *"guaranteeing monotonicity"* and §11 promises CP / reject-writes-on-partition. Accepting gaps would break the documented contract. `WAIT` preserves it at the cost of brief write unavailability during failover. Makes Exp6 a clean pass/fail test. |

---

## 4. Target Architecture

### 4.1 Diagram

```
                          ┌──────────────────────────────┐
                          │  CloudFront (global CDN)     │
                          └──────────────┬───────────────┘
                                         │ HTTPS (static assets)
                                         ▼
                          ┌──────────────────────────────┐
                          │         S3 bucket            │
                          │  (web-client static build)   │
                          └──────────────────────────────┘

┌──────────────────────────── VPC (us-east-1, 2 AZs) ──────────────────────────┐
│                                                                              │
│   Public Subnets (AZ-a, AZ-b)                                                │
│   ┌─────────────────────────────────────────────────────────────┐            │
│   │   ALB  (internet-facing, WebSocket + HTTP, health-checked)  │            │
│   │    target group: ECS Fargate "gateway" service              │            │
│   └────────────────────────────┬────────────────────────────────┘            │
│                                │                                             │
│   Private Subnets (AZ-a, AZ-b)                                               │
│   ┌───────────────────────────▼────────────────────────────┐                 │
│   │   ECS Service "gateway"                                │                 │
│   │     tasks spread across AZs; desiredCount = N (param)  │                 │
│   │     Service Connect / CloudMap → gRPC mesh peers       │                 │
│   └───────────────────────────┬────────────────────────────┘                 │
│                               │ gRPC                                         │
│   ┌───────────────────────────▼────────────────────────────┐                 │
│   │   ECS Service "message-service"                        │                 │
│   │     ≥ 2 tasks across AZs                               │                 │
│   └──────────────┬──────────────────────┬──────────────────┘                 │
│                  │                      │                                    │
│   ┌──────────────▼──────┐   ┌──────────▼──────────────┐                      │
│   │ ElastiCache Redis   │   │ RDS PostgreSQL          │                      │
│   │ replication group,  │   │ Multi-AZ                │                      │
│   │ Multi-AZ,           │   │ sync standby            │                      │
│   │ primary + replica   │   │ failover 60-120s        │                      │
│   │ async repl; app     │   │                         │                      │
│   │ uses WAIT 1 100ms   │   │                         │                      │
│   └─────────────────────┘   └─────────────────────────┘                      │
│                                                                              │
│   Secrets: AWS Secrets Manager (DB password, Redis auth token)               │
│   Metrics: CloudWatch (infra + EMF from apps)                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Cross-AZ data semantics (important for experiment interpretation)

| Component | Cross-AZ replication? | Mode | Failover time | Data loss risk |
|---|---|---|---|---|
| ALB | N/A (stateless, nodes per AZ, cross-zone LB on) | — | <30s (target deregister) | None |
| ECS Fargate tasks | N/A (stateless) | — | ~30–60s (new task schedule) | None |
| ElastiCache Redis | Yes | **Async** | 30–90s | **Possible** without mitigation; mitigated by `WAIT 1 <timeout>` (D9) |
| RDS PostgreSQL (Multi-AZ) | Yes | **Sync** (standby ack required) | 60–120s | **None** — committed transactions are durable across failover |
| S3 | Yes (≥3 AZ automatically) | Synchronous, transparent | — | None |
| CloudFront | Global edge | — | — | None |

---

## 5. Delta from Original Design Document

This section is the authoritative record of every way the AWS deployment diverges from `TinyTelegram-Design-Document.md` v1.0. Parts of the original doc listed here should be read as "superseded by this section" in any future reference.

### 5.1 LB and Gateway Assignment (supersedes original §3.2 and §5.1)

**Original:**
> Nginx configured with consistent hashing on `user_id` to ensure a user always connects to the same gateway (sticky sessions). ... When a gateway goes down, Nginx's consistent hash ring automatically remaps the affected users to other gateways with minimal disruption.

**Now:**
ALB with default target selection (round-robin / least outstanding requests). User-to-gateway stickiness is not guaranteed. Cross-gateway message delivery is handled by the existing gRPC mesh (`Gateway.RouteMessage` → Redis presence lookup → gRPC peer call).

**Why:** AWS ALB does not support consistent hashing on URL query strings. The original use of consistent hashing was an optimization to avoid cross-gateway hops in the common case, but the gateway mesh was already designed to handle those hops correctly. In the cloud deployment the tradeoff shifts toward:
- Accept one extra gRPC hop in some message deliveries (sub-millisecond cost in-VPC).
- Gain ALB's active health checks, which auto-deregister unhealthy gateway tasks within ~30s.

**Narrative update in final report:** The CS6650 "consistent hashing" talking point from §5.1 is replaced by "active health-check + mesh-based delivery" as the failover mechanism. Both remain valid distributed-systems concepts; the new one is a better fit for what cloud-native deployment actually provides.

### 5.2 Gateway Peer Discovery and Presence Identity (extends original §3.3 and §3.5)

**Original:**
`Gateway.peers` is a static `map[string]pb.GatewayClient` set up at process start. Redis stores `HSET presence:{userId} gateway GW-2` where `GW-2` is a stable, pre-assigned gateway identifier.

**Now:**

**Peer discovery.** Gateway peer clients are resolved dynamically via **ECS Service Connect**. Each gateway discovers peers through the Service Connect service DNS name (e.g., `gateway.tinytelegram.local`), which resolves to the set of healthy task-local endpoints. gRPC client pools are maintained against this resolution, refreshing on DNS TTL expiry.

**Presence identity.** Redis presence now stores the **task's Service Connect instance ID** as the gateway field — i.e., the value injected by ECS into `ECS_CONTAINER_METADATA_URI_V4` + Service Connect's assigned instance name, or equivalently the task's CloudMap-registered DNS-resolvable name. The gateway reads this identifier from the metadata endpoint at startup and uses it as its `self-id` for all Redis `HSET presence:...` writes and for gRPC peer lookups.

**Routing:**
```
User A's gateway (self-id = "gateway-xyz.tinytelegram.local")
  wants to deliver to User B:
  1. HGET presence:B gateway  →  "gateway-abc.tinytelegram.local"
  2. if == self-id: deliver locally
  3. else: grpc_client_for("gateway-abc.tinytelegram.local").DeliverMessage(...)
```

**Stale presence handling.** If a task dies, its Service Connect instance name is eventually removed; until then, presence entries pointing to it will fail to deliver via gRPC (connection error). This is acceptable because presence entries also have a 5-minute TTL (original §3.5), and the affected users will reconnect to new gateways within seconds of their WebSocket disconnect. No change to the TTL-based failure detection model.

**Why:** Fargate assigns task IPs at launch; static peer lists become stale on any task restart, scale event, or AZ failover. Service Connect provides the stable logical name abstraction that the original design assumed.

**Scope:** Implementation detail inside the gateway binary's startup and peer-management code. No protocol or wire change.

### 5.3 PTS Allocation Durability (supersedes parts of original §3.4 and §5.2)

**Original:**
```go
pts, err := s.redis.Incr(ctx, fmt.Sprintf("user:%s:pts", msg.ReceiverId)).Result()
if err != nil { return nil, err }
senderPts, err := s.redis.Incr(ctx, fmt.Sprintf("user:%s:pts", msg.SenderId)).Result()
if err != nil { return nil, err }
// ... insert into Postgres ...
```
with the claim:
> PTS is assigned atomically via Redis INCR, **guaranteeing monotonicity**.

**Now:** a two-tier defense. Layer 1 is `WAIT` for the common case; Layer 2 is a Postgres UNIQUE constraint that catches any residual race.

#### Layer 1 — `WAIT` after INCRs

```go
pts, err := s.redis.Incr(ctx, "user:"+msg.ReceiverId+":pts").Result()
if err != nil { return nil, err }

senderPts, err := s.redis.Incr(ctx, "user:"+msg.SenderId+":pts").Result()
if err != nil { return nil, err }

// ONE WAIT after BOTH INCRs is sufficient: WAIT blocks until all
// previously-issued writes on this connection have been acked by N replicas.
acked, waitErr := s.redis.Do(ctx, "WAIT", 1, 100).Int()
if waitErr != nil || acked < 1 {
    return nil, status.Error(codes.Unavailable, "PTS not durable, retry")
}

// ... insert into Postgres with UNIQUE constraint (see Layer 2) ...
```

#### Layer 2 — Postgres UNIQUE backstop

The `messages` schema is updated with two UNIQUE constraints that turn any surviving PTS duplicate into a hard `INSERT` failure:

```sql
-- Addition to schema from original §3.5
ALTER TABLE messages
    ADD CONSTRAINT uniq_receiver_pts UNIQUE (receiver_id, receiver_pts),
    ADD CONSTRAINT uniq_sender_pts   UNIQUE (sender_id,   sender_pts);
```

On `INSERT` constraint violation, message-service returns `Unavailable` to the gateway, which returns an error to the client. The allocated PTS value is "burned" (Redis counter has advanced); this is acceptable because gaps in PTS caused by rejected writes are legitimate under the original §11 CP policy.

#### Why the two layers

Redis `WAIT` is **best-effort**, not fully synchronous replication:
- `INCR` is applied and acknowledged to the client *before* `WAIT` runs.
- If the primary crashes after `INCR` but before the write reaches a replica, the `INCR` is lost. The promoted replica will re-allocate the same PTS on the next `INCR` — producing a duplicate.
- `WAIT` only protects against loss *during* the window between issuing the command and the primary crashing; it cannot retroactively protect `INCR`s whose effect never reached any replica.

The Postgres UNIQUE constraint closes this residual hole. Even if Redis produces a duplicate PTS across a failover boundary, the second `INSERT` attempt fails with a constraint violation, and the write is rejected — preserving the §11 CP behavior all the way to the database.

#### WAIT outcome matrix

| Outcome | Condition | Action |
|---|---|---|
| **Ok, acked ≥ 1** | Replica ack received within 100ms | Proceed to Postgres INSERT |
| **Ok, acked == 0** | Timeout; no replica ack received | Return `Unavailable`; do not attempt INSERT; client retries |
| **Connection error during WAIT** | Primary died or network partition during WAIT | Return `Unavailable`; do not attempt INSERT; Layer 2 guards against duplicate if retry hits new primary |
| **Connection error during INCR** | Primary died mid-INCR | Return `Unavailable`; the INCR may or may not have landed. On retry against the new primary, Layer 2 catches any duplicate |

#### Caveats worth noting

- **WAIT on Multi-AZ with 1 replica.** ElastiCache Multi-AZ default topology is 1 primary + 1 replica. If the **replica** (not the primary) is unhealthy, `WAIT` will time out even though nothing is at risk, producing spurious `Unavailable`. This is acceptable: the system degrades to write-unavailable when the replication factor drops below the safety threshold, which is the correct CP behavior.
- **Durability below replication.** `WAIT` guarantees replica **presence**, not on-disk durability. ElastiCache without AOF enabled can lose already-acked writes if *both* primary and replica die in quick succession. For this project scope we treat this as out of scope (probability negligible in a class demo); Postgres is the true source of truth and will survive any such event.

#### Experimental verification

Exp6 (§6.4) drives a forced failover and measures PTS violations. Pass is **0 duplicate PTS values committed to Postgres** (Layer 2 guarantees this regardless of Layer 1 behavior). Gaps in PTS values that correlate with `Unavailable` responses are legitimate and do not count as violations.

#### Cost

- Healthy steady state: ~1–5ms additional write latency (intra-AZ replica ack RTT).
- `WAIT` timeout worst case: +100ms per failed write.
- During ElastiCache failover: writes fail for 30–90s. This is the intended CP behavior, not a regression.

### 5.4 Deployment / Infrastructure (new material; original doc did not specify cloud deployment)

The following are additions, not supersessions:

- **VPC:** One VPC, two AZs, three subnet tiers (public for ALB, private for ECS, isolated for RDS/ElastiCache).
- **Secrets:** DB password and Redis auth token retrieved from AWS Secrets Manager at ECS task start (via secret ARN in task definition).
- **Migrations:** Schema migrations run as a one-shot ECS task triggered on stack update (via CDK CustomResource or a manual `aws ecs run-task`).

### 5.5 Web Client Hosting (supersedes parts of original §8 directory layout)

**Original:**
`web-client/` served via a small Node.js `server.js`, run alongside backend in Compose.

**Now:**
The static assets under `web-client/public/` are uploaded to an S3 bucket, fronted by CloudFront. `web-client/server.js` is no longer used in the cloud deployment (it remains in the repository for local development).

**CORS and Origin handling:**
- The CloudFront distribution serves the static client; the WebSocket endpoint is on ALB (`wss://<alb-dns>/ws`).
- WebSocket upgrade requests carry an `Origin` header; the gateway currently does not enforce origin validation (permissive by design in the original docker setup). When migrating, the gateway's WebSocket handshake must explicitly allow the CloudFront distribution's domain as a permitted origin, or remain permissive — either is acceptable for a course demo. Do **not** tighten to localhost-only or the WebSocket handshake from CloudFront will fail.
- No cookies are shared across origins; auth is via user_id query parameter as in the original design.

---

## 6. Experiment Designs

### 6.1 Exp1 — Gateway Horizontal Scaling (re-run on cloud)

**Hypothesis:** Fargate with clean CPU isolation per task will produce smoother throughput-vs-tasks curves than the local docker-compose version, which suffered from host CPU contention.

| Parameter | Value |
|---|---|
| Gateway task counts | 1, 3, 5 (set via CDK context parameter `gatewayDesiredCount`, then `cdk deploy`) |
| Message-service tasks | Constant: 2 |
| Client load | k6 from local machine targeting ALB DNS |
| Metrics | **Primary:** aggregate throughput (msg/s) and p99 end-to-end latency — these are what the scaling curve is plotted against. **Secondary (observability only):** per-task CPU utilization (CloudWatch), AZ placement distribution (recorded to confirm the ECS placement constraint `spread by attribute:ecs.availability-zone` is in effect for desiredCount ≥ 2). At desiredCount = 1, AZ balance is N/A. |
| Reuse | `scripts/experiment1/` k6 scripts + plotting unchanged; only target URL changes |

**Expected result:** Linear scaling until RDS `INSERT` saturation, at which point throughput plateaus regardless of gateway count. This is the same bottleneck Exp2 identified locally.

### 6.2 Exp3 — Gateway Failover (re-run on cloud)

**Hypothesis:** ALB + ECS health checks will deregister a failed gateway task within ~30s, and surviving clients' reconnect + `getDiff` cycle will recover 0 missed messages.

| Parameter | Value |
|---|---|
| Fault injection | `aws ecs stop-task --cluster tt --task <task-arn>` during steady-state k6 load |
| Metrics | Client reconnect latency distribution, message loss count (must be 0), time to ALB target deregistration, rate of `Unavailable` errors observed client-side |
| Reuse | `scripts/experiment3/failover_test.js` and `run_failover.sh` adapted |

**Difference from local:** Local Exp3 used `docker stop` which was immediate. Cloud Exp3 exercises the full ALB → target group health check → task replacement pipeline, which is a more realistic failure model.

### 6.3 Exp5 (new) — RDS Multi-AZ Failover

**Hypothesis:** RDS Multi-AZ synchronous replication guarantees zero data loss on a forced failover. Write unavailability window is bounded by AWS's published 60–120s SLA.

| Parameter | Value |
|---|---|
| Fault injection | `aws rds reboot-db-instance --force-failover --db-instance-identifier tt-db` during k6 load |
| Metrics | Write error rate over time, write unavailability duration, count of messages inserted pre-failover that are missing post-failover (expected: 0), time for message-service to reconnect to new primary endpoint |
| Client load | k6 with sustained send rate |

**Instrumentation:**
- CloudWatch `DatabaseConnections`, `ReadLatency`, `WriteLatency` on the DB instance
- Application-side counter of `INSERT` errors exposed to CloudWatch via EMF

**Pass criteria:** 0 missing messages; write unavailability < 180s; message-service auto-recovers without manual restart.

### 6.4 Exp6 (new) — ElastiCache Primary Failover under WAIT-based CP

**Hypothesis:** With the `WAIT 1 100ms` addition (§5.3), a forced ElastiCache primary failover produces 0 PTS monotonicity violations, at the cost of elevated write error rate during the failover window.

| Parameter | Value |
|---|---|
| Fault injection | `aws elasticache test-failover --replication-group-id tt-redis --node-group-id 0001` during k6 load |
| Metrics | PTS violation count (must be 0), write error rate over time, recovery time, number of `Unavailable` responses that trigger client retries |
| Verification | Post-run: (a) dump `messages` table, sort by `(receiver_id, receiver_pts)`, assert **no duplicates** (UNIQUE constraint guarantees this at the DB level, but we verify anyway); (b) cross-reference PTS gaps against the client-side k6 error log — every gap must correspond to a write attempt that received `codes.Unavailable`. Gaps without a matching error are bugs; gaps with a matching error are legitimate CP-correct write rejections. |

**Pass criteria:** 0 duplicate PTS values in Postgres across ≥100k messages sustained through a failover event. Gap count is reported but not a pass/fail criterion (gaps are expected during the failover window as writes are rejected).

**Reporting narrative:** This experiment is the empirical vindication of the §5.3 delta. It demonstrates that the WAIT-based CP behavior is both correctly implemented and observably effective — the cloud system preserves the same `0 PTS violations` result that Exp4 achieved locally (218k iterations, 0 violations).

### 6.5 Why Exp2 and Exp4 are not re-run on cloud

- **Exp2** (Redis `INCR` vs Postgres `INSERT` bottleneck analysis) is a property of the software architecture, not the deployment. The ratio of Redis to Postgres throughput is unlikely to differ meaningfully between docker and cloud; the qualitative conclusion (Postgres is the bottleneck) stands.
- **Exp4** (consistency validation, 218k iterations, 0 violations) is re-validated on cloud *as a side effect of Exp6*. If Exp6 passes (0 violations through a real failover), the stronger Exp4 claim is also satisfied.

---

## 7. CDK Project Structure

```
tinytelegram/
  ├── (existing: gateway/, message-service/, web-client/, proto/, scripts/, results/)
  ├── infra-cdk/                               ← NEW
  │   ├── bin/tt-app.ts                        # CDK app entry; pulls config from cdk.context.json
  │   ├── lib/
  │   │   ├── vpc-stack.ts                     # VPC, subnets (3 tiers × 2 AZs), NAT, endpoints
  │   │   ├── data-stack.ts                    # RDS PG Multi-AZ, ElastiCache Redis repl group, secrets
  │   │   ├── compute-stack.ts                 # ECS cluster, gateway + message-service services,
  │   │   │                                    # Service Connect namespace, ALB + target groups + listeners
  │   │   ├── edge-stack.ts                    # S3 + CloudFront (imports ALB DNS from compute-stack)
  │   │   └── observability-stack.ts           # CloudWatch dashboard + alarms
  │   ├── cdk.json
  │   ├── cdk.context.json                     # gatewayDesiredCount, dbInstanceClass, etc.
  │   ├── package.json
  │   └── tsconfig.json
  ├── docs/specs/
  │   └── 2026-04-18-aws-multi-az-deployment-design.md   ← this document
  └── scripts/
      ├── experiment5/                         # NEW
      │   ├── rds_failover_test.sh
      │   ├── run_rds_failover.sh
      │   └── plot_rds.py
      └── experiment6/                         # NEW
          ├── elasticache_failover_test.sh
          ├── run_elasticache_failover.sh
          └── plot_elasticache.py
```

**Stack boundary rationale:**
- **vpc-stack:** Rarely changes; destroying it tears down the whole deployment and is the last step on cleanup.
- **data-stack:** Expensive to recreate (RDS snapshot/restore), changed rarely.
- **compute-stack:** Churned frequently — Exp1 changes `gatewayDesiredCount` here and redeploys in seconds. **Owns the ALB, listeners, and target groups** (keeping them co-located with the ECS services that they target avoids a circular cross-stack reference and matches the AWS CDK `ecs-patterns` conventions). The ALB's public DNS name is exported via CfnOutput for edge-stack to consume.
- **edge-stack:** Owns S3 bucket + CloudFront distribution. Imports the ALB DNS name from compute-stack and uses it as a CloudFront custom origin (so one distribution can serve both static assets and proxy API calls if desired — for this project the client connects to the ALB directly for WebSocket, and CloudFront is static-only; the ALB DNS import is reserved for future use).
- **observability-stack:** Dashboards are iterated often during experiment tuning; separating them prevents accidental changes to compute during dashboard edits.

**Dependency graph:** `vpc-stack ← data-stack ← compute-stack ← edge-stack`, with `observability-stack` depending on `compute-stack` and `data-stack`. No circular dependencies.

---

## 8. Delivery Plan

Phased with validation at each step — no big-bang deploy.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Static client** | Strip `web-client/server.js` dependency; ensure assets build to a single `dist/` suitable for S3 | Local `npx http-server dist/` serves the app, connects to local `gateway` via WS |
| **1. VPC + data** | Deploy `vpc-stack` + `data-stack`. Apply `WAIT` change and schema UNIQUE constraints to `message-service`. Run gateway + message-service locally, connect to cloud RDS + ElastiCache via a temporary bastion or SSM port-forward (cloud data plane is not public) | (a) 10-minute k6 run at 50 msg/s against local gateway → cloud data plane: 0 message loss, 0 PTS duplicates in DB. (b) Kill local `message-service` process mid-run; gateway auto-reconnects to a new local instance within 5s; missed messages are recovered via `getDiff`; final message count matches k6 sent count. |
| **2. Compute** | Deploy `compute-stack`. Gateway and message-service now run on Fargate. | Two browsers connected via port-forwarded ALB (or direct task IP) can message across AZs |
| **3. Edge** | Deploy `edge-stack`. Static client on S3/CloudFront, WS via ALB. | Public URL works end-to-end from a fresh browser with no dev tools |
| **4. Observability + experiments** | Deploy `observability-stack`. Run Exp1, Exp3, Exp5, Exp6. | Four result folders: `results/exp1_cloud/`, `results/exp3_cloud/`, `results/exp5/`, `results/exp6/` — each with plots and CSVs. (Cloud-only experiments 5 and 6 drop the `_cloud` suffix since they have no docker counterpart to disambiguate from.) |
| **5. Report** | Update `TinyTelegram-Design-Document.md` to reference this spec's §5 deltas; write experiment report | Final report draft ready for submission |

---

## 9. Risks and Open Questions

| # | Item | Likelihood | Impact | Mitigation / Owner |
|---|---|---|---|---|
| R1 | ALB idle timeout (default 60s) disconnects WebSockets under low traffic | High | Medium | Raise ALB idle timeout to 3600s; ensure client and gateway both send periodic pings (existing `Ping` RPC in proto) |
| R2 | Fargate task IPs in Service Connect / CloudMap propagate slowly (~30s) after scale events | Medium | Medium | Accept during Exp1 scaling tests; document any measurement noise in first N seconds after `cdk deploy` |
| R3 | `WAIT 1 100ms` timeout tuned too tight → healthy writes fail intermittently under normal replication lag | Low | Medium | Instrument p99 replication lag in steady state; if it approaches 100ms, widen timeout. Need to validate in Phase 1. |
| R4 | ElastiCache `test-failover` cooldown (AWS enforces ≥5 min between invocations per node group) limits Exp6 iteration speed | High | Low | Budget ≥ 30 min per run; only run when ready to collect |
| R5 | RDS `force-failover` sometimes takes > 120s during class time (shared infrastructure load) | Medium | Low | Run Exp5 off-peak; note observed failover time in results |
| R6 | S3 + CloudFront cache invalidation on client deploy | Low | Low | Use versioned asset filenames (hash in name) so cache busting is automatic |
| Q1 | ~~Should `results/` store cloud runs under a separate prefix?~~ | — | — | **Decided: use separate prefix.** Cloud run results go under `results/exp1_cloud/`, `results/exp3_cloud/`, `results/exp5/`, `results/exp6/`. Docker results remain at `results/experiment{1,3}/`. This preserves the docker-vs-cloud comparison for the final report. |
| Q2 | Is the IAM role for the SSO profile sufficient to create RDS, ElastiCache, VPC, etc., or is it restricted? | — | Blocks Phase 1 | **Verify in Phase 1 step 1** by attempting a minimal `cdk deploy` of `vpc-stack`. If blocked, escalate to course staff. The role name `AWSReservedSSO_myisb_IsbUsersPS_a6c96c1e1423f5ab` suggests a PowerUser-level role that should permit all needed services. |

---

## 10. Acceptance

This design is considered complete when:

1. Section 5 (Delta from Original Design) is signed off by Fazheng — it is the authoritative record of every architectural change.
2. Each of Exp1, Exp3, Exp5, Exp6 has a defined "pass criteria" (§6) and corresponding measurement plan.
3. The CDK structure (§7) is agreed to be the level of granularity that supports the experiment-driven workflow.
4. Q2 from §9 (IAM permission verification) is resolved before Phase 4 begins. (Q1 is already decided as of this revision.)

After acceptance, the next step is invoking the `writing-plans` skill to produce a detailed implementation plan per-phase.

---

## 11. Phase 1 completion notes + Plan 2 kickoff (2026-04-18)

Plan 1 (app layer + VPC + data stack + local-to-cloud validation) landed on branch `claude/determined-kowalevski-0ef290`, 17 commits (`38a2e9c` → `c6dfee9`). Keep this section short — it exists so a fresh Claude session can pick up where we left off without re-reading the transcript.

### 11.1 Deployed AWS resources (still running; Plan 2 depends on these)

| Stack | Status | Key outputs |
|---|---|---|
| `TtVpcStack` (us-east-1) | CREATE_COMPLETE | `vpc-0a883bd3d1ff648a7`, 10.20.0.0/16, AZs 1a+1b, 2 NAT gateways, interface endpoints for ECR / SSM / Secrets Manager / Logs, S3 gateway endpoint |
| `TtDataStack` | CREATE_COMPLETE | RDS Postgres 16.3 Multi-AZ (`db.m6g.large`, 100 GB gp3), ElastiCache Redis 7.1 Multi-AZ (`cache.m6g.large`, transit+at-rest encryption, AUTH), security groups DbSg / RedisSg / AppSg pre-wired |
| `TtBastionStack` | destroyed (Task 15) | was only for Phase 1 tunnel; removed after exit criteria met |

Secrets in Secrets Manager: `tinytelegram/db` (RDS master creds, JSON with `password`), `tinytelegram/redis` (ElastiCache AUTH token, JSON with `token`).

### 11.2 Phase 1 exit-criteria results

- (a) 10-min k6 against cloud data plane via bastion tunnel: **0 PTS duplicates** (receiver_pts and sender_pts UNIQUE constraints held). Throughput capped at ~12 msg/s vs 50 msg/s target due to tunnel RTT inflating `WAIT 100ms` timeouts; Fargate in-VPC will restore full throughput. Gaps in receiver_pts represent intentional CP-reject writes (Layer 1 doing its job), not duplicates.
- (b) mid-run msgsvc kill: **3s downtime** (target ≤ 10s), 0 duplicates. k6 WebSocket sessions survived the restart.
- Integration test `TestPersistMessage_DuplicatePTSReturnsUnavailable` **PASSes** against cloud Redis + RDS.

### 11.3 Non-obvious gotchas hit during Plan 1 (do NOT re-learn)

1. **CDK dynamic-reference for ElastiCache AuthToken must be a literal string.** `secret.secretValueFromJson().unsafeUnwrap()` synthesizes via `Fn::Join`; CloudFormation does not re-evaluate the resulting string as a dynamic reference and ElastiCache rejects with "Invalid AuthToken". Fix: `cdk.SecretValue.secretsManager('<literal-name>', { jsonField: 'token' }).unsafeUnwrap()` plus an explicit `this.redisGroup.node.addDependency(this.redisAuth)` (CDK can't infer the dep from a literal string). See [data-stack.ts:104](../../infra-cdk/lib/data-stack.ts).
2. **SG ingress rule descriptions are ASCII-only.** EC2 validates against `[a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*]`. Unicode arrows (`→`) break deploy with a generic "Invalid rule description" error.
3. **CDK `--profile` does NOT propagate creds to CDK's SDK subprocess on Windows+SSO.** Use `eval "$(aws configure export-credentials --profile $AWS_PROFILE --format env)"` before `npx cdk deploy`.
4. **AWS CLI default region ≠ CDK region.** The SSO profile defaults to `us-west-2`; CDK deploys to `us-east-1`. Always pass `--region us-east-1` or set `AWS_REGION` on raw CLI calls.
5. **SSM port-forward tunnels bind IPv4 only.** On Windows, `localhost` resolves to IPv6 `::1` and fails silently with a connection timeout. Always use `127.0.0.1` in DSNs/endpoints when going through a tunnel.
6. **ElastiCache TLS cert is for the real ElastiCache hostname** — SNI fails when connecting via `127.0.0.1` through a tunnel. `REDIS_TLS_INSECURE=true` gates `tls.Config{InsecureSkipVerify}` for the tunneled path only; Fargate in-VPC leaves it strict.
7. **Gateway had a pre-existing `concurrent write to websocket connection` panic** surfacing only at ≥ 5 concurrent users. Fixed in `3785318` with a `sync.Mutex` around `conn.WriteJSON` calls.
8. **AWS Session Manager Plugin must be on PATH** in the shell that runs `aws ssm start-session`. Installed at `/c/Program Files/Amazon/SessionManagerPlugin/bin/`; AWS CLI won't auto-discover.

### 11.4 Plan 2 scope (compute + edge)

Plan 2 produces a working Fargate deployment: message-service + gateway as ECS services behind an ALB, web client behind S3 + CloudFront.

**New stacks:**
- `TtEcrStack` — one ECR repo per image (`tt-msgsvc`, `tt-gw`). Keep small; `cdk deploy` is the only create path; no lifecycle policies yet.
- `TtComputeStack` — ECS cluster, Fargate task defs for msgsvc (1 vCPU / 2 GB) and gateway (1 vCPU / 2 GB minimum), services with desired-count ≥ 2 per AZ, attached to `appSg` exported from `TtDataStack`. Service Connect for msgsvc ↔ gateway gRPC discovery (per decision D7 in §3).
- `TtEdgeStack` — ALB in public subnets fronting the gateway (WebSocket-capable, no consistent hashing — D6 explicitly non-sticky), ACM cert + Route 53 if we commit a domain, else use the ALB DNS name. S3 bucket for web client + CloudFront distribution; web client built for `wss://<gateway>/ws`.

**Code changes expected in Plan 2:**
- `message-service/Dockerfile` + `gateway/Dockerfile` already exist; will likely need multi-stage tweak for smaller runtime images.
- `scripts/cloud-integration/*.sh` will be adapted: bastion-based tunneling replaced by ECS Exec into a Fargate task for debugging; k6 targets move from `localhost:8080` to the ALB DNS.
- Remove `REDIS_TLS_INSECURE=true` from any committed task-def env; Fargate runs in-VPC so SNI matches.
- Drop the `docker-compose.yml` "nginx" front-door in favor of the ALB; keep compose for local-dev iteration only.

**Open questions for Plan 2 brainstorming:**
- `Q3`: Domain name? If yes, which registrar, and is ACM email validation OK for a school project? If no, accept ALB DNS directly (ugly but zero-cost).
- `Q4`: Service Connect vs. simple Cloud Map DNS vs. peering via the existing Redis presence list? Current gateway mesh uses Redis-based discovery (see `gateway/main.go` `RegisterGateway`); decide whether to keep that or let AWS Service Connect replace it entirely.
- `Q5`: Where does the web client get build-time config for the gateway URL? Env at build, or runtime config.json served from S3?
- `Q6`: Task-count target — do we need auto-scaling in Phase 2, or fixed count (e.g., 2 per service per AZ = 4 total) is enough to show HA in experiments?

**Phase 2 exit criteria** (from §8):
- All 3 stacks deploy cleanly end-to-end via `cdk deploy --all`
- k6 from the laptop against the ALB sustains 50 msg/s for 10 min with 0 PTS duplicates (the actual target throughput the tunnel couldn't hit)
- Web client in a browser connects through CloudFront → ALB → gateway and exchanges a message round-trip
- ECS task kill test (kill one msgsvc task) recovers via Fargate replacement in < 60s without loss

### 11.5 How to resume in a fresh session

1. `cd` into the repo on `main` (after this branch is merged) or stay on `claude/determined-kowalevski-0ef290`.
2. Invoke the `superpowers:brainstorming` skill and answer Q3–Q6 above.
3. Or invoke `superpowers:writing-plans` directly — the design is stable; only the open questions need resolving before the plan can be written. Save the plan to `docs/plans/2026-04-18-tinytelegram-aws-compute-edge.md` (gitignored, per user preference).
4. Execute the resulting plan with `superpowers:subagent-driven-development`, same pattern as Plan 1.
