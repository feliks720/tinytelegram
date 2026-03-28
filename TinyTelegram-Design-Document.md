# TinyTelegram — Distributed Instant Messaging System

## System Design Document | CS6650 Distributed Systems

**Author:** Fazheng  
**Date:** February 2026  
**Version:** 1.0

---

## 1. Overview

TinyTelegram is a distributed instant messaging system inspired by Telegram's architecture. The project fuses two core distributed systems challenges into a unified design:

- **Part A — Message Routing & High Availability:** Stateful WebSocket gateways with cross-node message routing and automatic failover.
- **Part B — Incremental Multi-Device Sync:** A Progressive Total Sequence (pts) mechanism ensuring consistent, gap-free message delivery across multiple client devices.

The system demonstrates consistent hashing, gRPC-based service communication, global message ordering, incremental state synchronization, and fault tolerance — all key topics in CS6650.

---

## 2. Architecture Overview

The system is organized into four layers:

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐   │
│  │ Web (WS) │  │ Mobile   │  │ Desktop  │  │ Local Cache│   │
│  │ React+TS │  │ (future) │  │ (future) │  │ IndexedDB  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │ + pts      │   │
│       │             │             │        └────────────┘   │
└───────┼─────────────┼─────────────┼─────────────────────────┘
        │             │             │
        ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│                    LOAD BALANCER                            │
│            Nginx (consistent hash by user_id)               │
└──────────┬──────────────┬──────────────┬────────────────────┘
           │              │              │
           ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────┐
│                   GATEWAY LAYER (Part A)                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│  │  Gateway-1   │ │  Gateway-2   │ │  Gateway-3   │         │
│  │ Map[uid]→WS  │ │ Map[uid]→WS  │ │ Map[uid]→WS  │         │
│  │ users: A,C,E │ │ users: B,D,F │ │ users: G,H,I │         │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘         │
│         ◄─────────── gRPC mesh ───────────►                 │
│         │                │                │                 │
│         │  Presence lookup via Redis      │                 │
└─────────┼────────────────┼────────────────┼─────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│                MESSAGE SERVICE LAYER (Part B)               │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  Message Service │  │   Sync Service   │                 │
│  │ persist + assign │  │ getDiff(client   │                 │
│  │ global pts       │  │       _pts)      │                 │
│  └────────┬─────────┘  └────────┬─────────┘                 │
└───────────┼─────────────────────┼───────────────────────────┘
            │                     │
            ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   INFRASTRUCTURE LAYER                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │    Redis 7   │  │ PostgreSQL 16│  │  Prometheus  │       │
│  │ presence,pts │  │ messages,    │  │  + Grafana   │       │
│  │ pub/sub      │  │ users        │  │  (metrics)   │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Component Design

### 3.1 Client Layer

Each client maintains a local message cache and a `pts` (Progressive Total Sequence) counter representing the last known state. The sync protocol works as follows:

1. On connect, the client sends its local `pts` to the Sync Service via `getDiff(client_pts)`.
2. The server returns all messages with `pts > client_pts`.
3. The client merges these into its local cache and updates its local `pts`.
4. During active sessions, new messages arrive in real-time via WebSocket, each carrying a `pts` value. If a gap is detected (e.g., local pts=10 but incoming pts=13), the client triggers a `getDiff` to fill the gap.

**Key data structures:**

```typescript
interface LocalState {
  userId: string;
  pts: number;                    // last synced pts
  messages: Map<string, Message>; // msgId → Message
}

interface Message {
  id: string;
  senderId: string;
  receiverId: string;
  content: string;
  pts: number;
  timestamp: number;
}
```

### 3.2 Load Balancer

Nginx is configured with consistent hashing on `user_id` to ensure a user always connects to the same gateway (sticky sessions). This avoids the need for broadcast-based routing in the common case.

```nginx
upstream gateways {
    hash $arg_user_id consistent;
    server gateway-1:8080;
    server gateway-2:8080;
    server gateway-3:8080;
}
```

When a gateway goes down, Nginx's consistent hash ring automatically remaps the affected users to other gateways with minimal disruption.

### 3.3 Gateway Layer (Part A Core)

Each gateway is a stateful Go process that manages WebSocket connections and routes messages to the correct destination.

**Responsibilities:**

- Maintain a local `Map[UserID] → *websocket.Conn` registry.
- On user connect: register `user_id → gateway_id` in Redis (presence).
- On user disconnect: remove the Redis presence entry and clean up the local map.
- On incoming message: look up the target user's gateway via Redis, then forward via gRPC.

**Gateway struct (Go):**

```go
type Gateway struct {
    id          string
    connections sync.Map  // map[string]*websocket.Conn
    msgClient   pb.MessageServiceClient  // gRPC to Message Service
    peers       map[string]pb.GatewayClient  // gRPC to peer gateways
    redis       *redis.Client
}

func (g *Gateway) RouteMessage(ctx context.Context, msg *pb.ChatMessage) error {
    // 1. Persist message and get pts via Message Service
    resp, err := g.msgClient.PersistMessage(ctx, msg)
    if err != nil { return err }

    // 2. Look up target user's gateway
    targetGW, err := g.redis.HGet(ctx, "presence:"+msg.ReceiverId, "gateway").Result()
    if err == redis.Nil {
        // User offline — message already persisted, getDiff will deliver it later
        return nil
    }

    // 3. Forward to target gateway via gRPC
    if targetGW == g.id {
        return g.deliverLocal(msg.ReceiverId, resp)
    }
    return g.peers[targetGW].DeliverMessage(ctx, resp)
}
```

**Cross-gateway routing flow:**

```
User A (on GW-1) sends msg to User B (on GW-2):

1. GW-1 receives msg via WebSocket
2. GW-1 calls MessageService.PersistMessage() → gets pts=42
3. GW-1 queries Redis: HGET presence:userB gateway → "GW-2"
4. GW-1 calls GW-2.DeliverMessage() via gRPC
5. GW-2 looks up local map, pushes to User B's WebSocket
```

### 3.4 Message Service Layer (Part B Core)

The Message Service is responsible for message persistence, global pts assignment, and incremental sync.

**PTS allocation:**

Each user has an independent pts counter stored in Redis. When a message is sent to user X, we atomically increment user X's pts:

```go
func (s *MessageService) PersistMessage(ctx context.Context, msg *pb.ChatMessage) (*pb.PersistedMessage, error) {
    // Atomic pts increment for the receiver
    pts, err := s.redis.Incr(ctx, fmt.Sprintf("user:%s:pts", msg.ReceiverId)).Result()
    if err != nil { return nil, err }

    // Also increment sender's pts (they need to see their own sent message)
    senderPts, err := s.redis.Incr(ctx, fmt.Sprintf("user:%s:pts", msg.SenderId)).Result()
    if err != nil { return nil, err }

    // Persist to PostgreSQL
    _, err = s.db.Exec(ctx,
        `INSERT INTO messages (id, sender_id, receiver_id, content, receiver_pts, sender_pts, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        uuid.New(), msg.SenderId, msg.ReceiverId, msg.Content, pts, senderPts)

    return &pb.PersistedMessage{
        Message:     msg,
        ReceiverPts: pts,
        SenderPts:   senderPts,
    }, err
}
```

**getDiff (Incremental Sync):**

```go
func (s *SyncService) GetDiff(ctx context.Context, req *pb.GetDiffRequest) (*pb.GetDiffResponse, error) {
    rows, err := s.db.Query(ctx,
        `SELECT id, sender_id, receiver_id, content,
                CASE WHEN receiver_id = $1 THEN receiver_pts ELSE sender_pts END as pts,
                created_at
         FROM messages
         WHERE (receiver_id = $1 OR sender_id = $1)
           AND CASE WHEN receiver_id = $1 THEN receiver_pts ELSE sender_pts END > $2
         ORDER BY pts ASC
         LIMIT 1000`,
        req.UserId, req.ClientPts)

    // Marshal and return messages...
}
```

### 3.5 Infrastructure Layer

**Redis responsibilities:**

| Key Pattern | Purpose | TTL |
|---|---|---|
| `presence:{userId}` | Hash: gateway\_id, connected\_at | 5 min (refreshed by heartbeat) |
| `user:{userId}:pts` | Integer: current pts counter | Persistent |
| Channel: `gateway:{gwId}:events` | Pub/Sub for gateway lifecycle events | N/A |

**PostgreSQL schema:**

```sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(256) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id    UUID NOT NULL REFERENCES users(id),
    receiver_id  UUID NOT NULL REFERENCES users(id),
    content      TEXT NOT NULL,
    sender_pts   BIGINT NOT NULL,
    receiver_pts BIGINT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Critical indexes for getDiff performance
CREATE INDEX idx_messages_receiver_pts ON messages(receiver_id, receiver_pts);
CREATE INDEX idx_messages_sender_pts ON messages(sender_id, sender_pts);
```

---

## 4. gRPC Service Definitions

```protobuf
syntax = "proto3";
package tinytelegram;

// Gateway-to-Gateway communication
service GatewayService {
    rpc DeliverMessage(PersistedMessage) returns (DeliveryAck);
    rpc Ping(PingRequest) returns (PongResponse);
}

// Gateway-to-MessageService communication
service MessageService {
    rpc PersistMessage(ChatMessage) returns (PersistedMessage);
    rpc GetDiff(GetDiffRequest) returns (GetDiffResponse);
    rpc GetUserPts(PtsRequest) returns (PtsResponse);
}

message ChatMessage {
    string sender_id = 1;
    string receiver_id = 2;
    string content = 3;
    int64  client_timestamp = 4;
}

message PersistedMessage {
    string id = 1;
    ChatMessage message = 2;
    int64 receiver_pts = 3;
    int64 sender_pts = 4;
    int64 server_timestamp = 5;
}

message GetDiffRequest {
    string user_id = 1;
    int64  client_pts = 2;
    int32  limit = 3;
}

message GetDiffResponse {
    repeated PersistedMessage messages = 1;
    int64 current_pts = 2;
}
```

---

## 5. Key Distributed Systems Concepts Demonstrated

### 5.1 Consistent Hashing (User → Gateway Mapping)

Rather than broadcasting messages to all gateways, users are deterministically mapped to gateways via consistent hashing on their `user_id`. This ensures O(1) routing lookups, which significantly reduces the typical N^2 gossip or broadcast overhead common in naive distributed chats. When a gateway joins or leaves, only a fraction of users need to be remapped — this is demonstrated during the failover demo.

### 5.2 Global Ordering via PTS

The `pts` mechanism provides a per-user total causal of all messages. Unlike wall-clock timestamps which can drift across nodes, `pts` is assigned atomically via Redis `INCR`, guaranteeing monotonicity. We chose Redis `INCR` over implementing a custom consensus algorithm (like Raft) because it offloads the complexity of distributed coordination to a highly optimized, production-proven in-memory data store, keeping the project focus primarily on the core message routing and synchronization logic. This is conceptually similar to Lamport clocks but scoped per-user for efficiency — there is no need for a global total order across all users.

### 5.3 Incremental State Synchronization

The `getDiff` API enables clients to sync only missing messages. This is analogous to log-based replication (similar in spirit to Aurora's logical replication — the client acts like a replica catching up via the replication log, where `pts` serves as the log sequence number).

### 5.4 Fault Tolerance & Failover

When a gateway crashes:

1. Redis presence entries expire (TTL-based failure detection).
2. Clients detect WebSocket disconnection and reconnect (hitting the load balancer, which remaps them to a live gateway).
3. On reconnect, the client calls `getDiff(local_pts)` to recover any messages missed during downtime.
4. No messages are lost because persistence happens before routing.

This implements an "at-least-once" delivery guarantee. Duplicate detection is handled client-side via message IDs.

### 5.5 Separation of Stateful and Stateless Concerns

The gateway layer is stateful (holds WebSocket connections) while the message service is stateless (can be horizontally scaled). This separation is a classic distributed systems pattern — stateful components are harder to scale, so we minimize what they hold.

---

## 6. Message Flow (End-to-End)

### 6.1 Normal Flow: Both Users Online

1. **User A** sends a message via WebSocket (`WS: send msg`) to their connected **Gateway** (`GW-1`).
2. **GW-1** calls `Persist` via gRPC to the **Message Service**.
3. **Message Service** increments the progressive total sequence (`INCR pts`) for the user in **Redis** and receives the new value (e.g., `pts=42`).
4. **Message Service** inserts the message and the associated `pts` into **PostgreSQL**.
5. **Message Service** returns the persisted message and the `pts` value to **GW-1**.
6. **GW-1** queries **Redis** for User B's presence (`HGET presence:B`).
7. **Redis** replies with the ID of the gateway User B is connected to (e.g., `"GW-2"`).
8. **GW-1** sends a `Deliver` command via gRPC to **GW-2**.
9. **GW-2** pushes the message via WebSocket to **User B**.
10. **GW-1** sends a WebSocket acknowledgment to **User A** confirming the message was stored (e.g., `ack {pts=42}`).

### 6.2 Offline Recovery Flow

**Scenario:** User A reconnects after downtime (their local `pts=38`, but the server `pts=42`).

1. **Client** connects to a **Gateway** via WebSocket.
2. **Client** issues a sync request with its local state: `getDiff(pts=38)`.
3. **Gateway** makes a gRPC call to the **Sync Service**: `GetDiff(38)`.
4. **Sync Service** queries **PostgreSQL** (`SELECT pts>38`).
5. **PostgreSQL** returns the missing messages (e.g., `msgs[39,40,41,42]`).
6. **Sync Service** returns these messages to the **Gateway**.
7. **Gateway** performs a batch WebSocket push to deliver all missing messages to the **Client**.
8. **Client** merges the messages into its local cache and updates its local state (e.g., `local pts=42`).

---

## 7. Demo Scenarios

### Demo 1: Cross-Gateway Messaging
Open two browser tabs. User A is on Gateway-1, User B is on Gateway-2. Send messages and observe gRPC routing in real-time via logs.

### Demo 2: Multi-Device Sync
Open three browser tabs as the same user. Send a message from tab 1 — it appears instantly on tabs 2 and 3 with consistent pts ordering.

### Demo 3: Gateway Failover
While chatting, kill Gateway-1 via `docker stop gateway-1`. Observe: client auto-reconnects to Gateway-2 or Gateway-3, calls getDiff, and all missed messages appear immediately.

### Demo 4: Offline Recovery
Disconnect a client (browser offline mode). Send several messages to that user from another client. Reconnect — watch the "waterfall" of messages sync via getDiff.

### Demo 5: Metrics Dashboard
Show Prometheus/Grafana dashboard with: active WebSocket connections per gateway, message throughput (msgs/sec), getDiff call frequency, p99 message delivery latency.

---

## 8. Project Directory Structure

```
tinytelegram/
├── proto/                     # gRPC definitions
│   └── tinytelegram.proto
├── gateway/                   # Gateway service (Part A)
│   ├── main.go
│   ├── server.go              # WebSocket handler
│   ├── router.go              # Message routing logic
│   ├── presence.go            # Redis presence management
│   └── peer.go                # gRPC peer gateway client
├── message-service/           # Message + Sync service (Part B)
│   ├── main.go
│   ├── persist.go             # PersistMessage handler
│   ├── sync.go                # GetDiff handler
│   └── sequence.go            # PTS allocation via Redis
├── web-client/                # React frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   └── useSync.ts
│   │   ├── store/
│   │   │   └── messageStore.ts  # IndexedDB + pts
│   │   └── components/
│   │       ├── ChatWindow.tsx
│   │       └── ConnectionStatus.tsx
│   └── package.json
├── docker-compose.yml         # Full stack orchestration
├── nginx.conf                 # Load balancer config
├── migrations/                # PostgreSQL schema
│   └── 001_init.sql
├── prometheus.yml             # Monitoring config
└── README.md
```

---

## 9. Technology Stack

| Component | Technology | Rationale |
|---|---|---|
| Gateway Service | Go 1.22 + gorilla/websocket | High concurrency, native goroutine per connection |
| Inter-service RPC | gRPC + Protocol Buffers | Type-safe, efficient binary serialization |
| Message Service | Go 1.22 | Consistent stack, shared proto definitions |
| State Store | Redis 7 | Atomic INCR for pts, O(1) presence lookup, pub/sub |
| Persistent Store | PostgreSQL 16 | ACID guarantees for message history, efficient range queries |
| Frontend | React + TypeScript | Multi-tab support, IndexedDB for local cache |
| Load Balancer | Nginx | Consistent hash module, proven WebSocket proxy |
| Orchestration | Docker Compose | Reproducible multi-node setup for demo |
| Monitoring | Prometheus + Grafana | Real-time metrics visualization |

---

## 10. Development Milestones

| Phase | Duration | Deliverables |
|---|---|---|
| Phase 1: Foundation | Weeks 1-3 | Proto definitions, basic Gateway with WebSocket, PostgreSQL schema, Docker Compose |
| Phase 2: Core Routing | Weeks 4-6 | Redis presence, cross-gateway gRPC routing, single-node message persistence |
| Phase 3: PTS & Sync | Weeks 7-9 | PTS allocation, getDiff API, client-side sync engine with IndexedDB |
| Phase 4: High Availability | Weeks 10-11 | Failover handling, auto-reconnect, offline queue, connection draining |
| Phase 5: Polish & Demo | Weeks 12-14 | Grafana dashboard, demo scripts, load testing, final presentation |

---

## 11. Connection to Distributed Systems Theory

| Course Concept | TinyTelegram Implementation |
|---|---|
| Lamport Clocks | PTS provides causal ordering per user stream |
| Consistent Hashing | User-to-gateway assignment via hash ring |
| Replication | Messages persisted before routing (write-ahead) |
| Failure Detection | Redis TTL-based presence expiry |
| Exactly-Once Semantics | At-least-once delivery + client-side dedup via message ID |
| CAP Theorem | CP emphasis: The system prioritizes strict message ordering (pts) and persistence before routing. Under partition, if the sequence allocator fails, the system favors consistency over availability by rejecting writes rather than introducing out-of-order messages. |
| MapReduce (conceptual) | getDiff is analogous to a reduce over the message log |
