# TinyTelegram — Distributed Instant Messaging System

**CS6650 Distributed Systems Project**

A production-inspired distributed messaging system demonstrating consistent hashing, gRPC-based service communication, global message ordering via Redis PTS (Progressive Total Sequence), and fault-tolerant gateway architecture.

🔗 **[Design Document](./TinyTelegram-Design-Document.md)** | 📊 **[Project Report](./TinyTelegram_report.pdf)**

---

## 🎯 **Quick Start**

### **1. Start the System**

```bash
# Start all services (2 gateways, message-service, Redis, PostgreSQL, Nginx)
docker-compose up -d --build

# Check all services are healthy
docker-compose ps
```

### **2. Open the Web Client**

```bash
cd web-client
node server.js
```

Then open **http://localhost:3000** in your browser.

### **3. Test Multi-Device Sync**

1. Open **multiple browser tabs** to http://localhost:3000
2. Connect as the same user (e.g., "alice") in all tabs
3. Send a message from one tab
4. **Observe**: Message appears in all tabs with consistent PTS values

### **4. Test Cross-Gateway Routing**

1. Tab 1: Connect as "alice"
2. Tab 2: Connect as "bob"
3. alice sends message to bob
4. **Observe**: Message routes across gateways via gRPC (check logs)

---

## 🏗️ **Architecture**

```
┌─────────────┐
│  Web Client │ (React/Vanilla JS, WebSocket, PTS tracking)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Nginx (LB)  │ (Consistent hash on user_id)
└──────┬──────┘
       │
       ▼
┌──────────────────────────────────────┐
│      Gateway Layer (Stateful)        │
│  ┌────────┐  ┌────────┐  ┌────────┐  │
│  │  GW-1  │  │  GW-2  │  │  GW-3  │  │ (gRPC mesh for routing)
│  └───┬────┘  └───┬────┘  └───┬────┘  │
└──────┼───────────┼───────────┼───────┘
       │           │           │
       └───────────┴───────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│   Message Service (Stateless)       │
│   - PersistMessage                  │
│   - GetDiff (incremental sync)      │
│   - GetUserPts                      │
└─────────────────────────────────────┘
       │                   │
       ▼                   ▼
┌──────────┐         ┌──────────┐
│  Redis   │         │ Postgres │
│ (PTS,    │         │(Messages,│
│presence) │         │ history) │
└──────────┘         └──────────┘
```

### **Key Components:**

- **Gateway** (Go): Stateful WebSocket server, maintains user connections, routes messages via gRPC
- **Message Service** (Go): Stateless, handles persistence, PTS allocation (Redis INCR), getDiff sync
- **Redis**: Presence tracking, atomic PTS counters, pub/sub
- **PostgreSQL**: Message history with indexed PTS columns
- **Nginx**: Load balancer with consistent hashing on `user_id`

---

## 🧪 **Experiments**

### **Experiment 1 — Gateway Horizontal Scaling** ✅

**Goal**: Validate that consistent hashing distributes load linearly across 1/3/5 gateways under 2000 WebSocket connections.

```bash
cd scripts/experiment1
./run_all.sh
python3 plot_results.py ../../results/experiment1
```

**Expected Results**: Near-linear memory distribution per gateway. Results: [results/experiment1/](./results/experiment1/)

---

### **Experiment 2 — Write Path Bottleneck Analysis** ✅

**Goal**: Isolate Redis INCR vs Postgres INSERT latency to identify bottlenecks.

```bash
cd scripts/experiment2
k6 run load_test.js
k6 run bottleneck_test.js
python3 plot_results.py ../../results/experiment2
```

**Expected Results**: Redis INCR ~1ms, Postgres INSERT ~5ms. Redis is not the bottleneck. Results: [results/experiment2/](./results/experiment2/)

---

### **Experiment 3 — Gateway Failover & Recovery** 🆕

**Goal**: Measure reconnection time when a gateway fails under load. Validate getDiff recovery.

```bash
cd scripts/experiment3
./run_failover.sh
python3 plot_failover.py ../../results/experiment3
```

**What it does**:
1. Establishes 50 WebSocket connections across 3 gateways
2. After 30s baseline, kills gateway1
3. Measures:
   - Reconnection time (p50, p95, p99)
   - Connection redistribution to gateway2/3
   - Message loss during failover
   - getDiff recovery effectiveness

**Expected Results**: p95 reconnection < 5s, 0 message loss (via getDiff recovery)

---

### **Experiment 4 — Consistency Validation** 🆕

**Goal**: Verify Redis PTS maintains strict ordering under partial failures and concurrent load.

```bash
cd scripts/experiment4
./run_consistency.sh
python3 plot_consistency.py ../../results/experiment4
```

**What it does**:
1. Sends messages from 50 concurrent users
2. After 90s, restarts message-service (simulates crash between PTS acquisition and gRPC delivery)
3. Validates:
   - **Zero PTS ordering violations** (critical)
   - PTS gap detection (triggers getDiff)
   - No duplicate message IDs
   - Postgres sequence continuity

**Pass Criteria**: 0 order violations, consistency score > 99%

---

## 📡 **API Reference**

### **WebSocket (Client ↔ Gateway)**

**Connect:**
```
ws://localhost:8080/ws?user_id=alice
```

**Send Message:**
```json
{
  "receiver_id": "bob",
  "content": "Hello from alice!"
}
```

**Receive Message (PersistedMessage):**
```json
{
  "id": "uuid",
  "message": {
    "sender_id": "alice",
    "receiver_id": "bob",
    "content": "Hello from alice!"
  },
  "sender_pts": 42,
  "receiver_pts": 17,
  "server_timestamp": 1234567890
}
```

**Acknowledgment:**
```json
{
  "type": "ack",
  "message_id": "uuid",
  "sender_pts": 42
}
```

### **gRPC (Internal Services)**

See [proto/gateway.proto](./proto/gateway.proto) for full definitions.

**Key RPCs:**
- `PersistMessage(ChatMessage) → PersistedMessage` - Atomically increments PTS and persists to Postgres
- `GetDiff(GetDiffRequest) → GetDiffResponse` - Returns messages with `pts > client_pts`
- `GetUserPts(PtsRequest) → PtsResponse` - Returns current PTS for a user
- `DeliverMessage(PersistedMessage) → DeliveryAck` - Gateway-to-gateway delivery

---

## 🔑 **Key Distributed Systems Concepts**

| Concept | Implementation |
|---------|---------------|
| **Consistent Hashing** | Nginx hash on `user_id` → gateway assignment (O(1) routing) |
| **Global Ordering** | Redis `INCR` for atomic per-user PTS allocation |
| **Incremental Sync** | `getDiff(local_pts)` fetches only `pts > local_pts` messages |
| **Fault Tolerance** | Redis TTL-based presence, client auto-reconnect + getDiff recovery |
| **CAP Theorem** | CP system: Prioritizes consistency (strict PTS ordering) over availability |
| **Stateful/Stateless** | Gateways are stateful (WebSocket), message-service is stateless (horizontal scale) |

---

## 📂 **Project Structure**

```
tinytelegram/
├── gateway/                  # Go WebSocket gateway service
│   ├── handler/             # WebSocket & health handlers
│   ├── grpc/                # gRPC server for peer delivery
│   ├── peer/                # gRPC client for peer gateways
│   ├── msgclient/           # gRPC client for message-service
│   └── store/               # Redis presence management
├── message-service/         # Go message persistence & sync
│   ├── handler/             # HTTP handlers (health, redis-only)
│   ├── grpc/                # gRPC server (PersistMessage, GetDiff)
│   └── store/               # Redis (PTS) & Postgres (messages)
├── proto/                   # Protocol Buffer definitions
│   └── gateway.proto
├── web-client/              # Browser-based WebSocket client
│   ├── public/
│   │   ├── index.html       # UI
│   │   └── app.js           # WebSocket client logic
│   └── server.js            # Static file server
├── scripts/                 # Experiment orchestration
│   ├── experiment1/         # Gateway scaling
│   ├── experiment2/         # Bottleneck analysis
│   ├── experiment3/         # Failover recovery (NEW)
│   └── experiment4/         # Consistency validation (NEW)
├── results/                 # Experiment outputs
├── infra/                   # Docker Compose configs
│   ├── nginx/nginx.conf     # Load balancer
│   ├── docker-compose.1gw.yml
│   ├── docker-compose.3gw.yml
│   └── docker-compose.5gw.yml
├── docker-compose.yml       # Default 2-gateway setup
└── README.md                # This file
```

---

## 🛠️ **Development**

### **Prerequisites**

- Docker & Docker Compose
- Go 1.22+ (for local development)
- Node.js (for web client)
- k6 (for load testing): `brew install k6` or [k6.io](https://k6.io)
- Python 3 + matplotlib (for plotting)

### **Local Development (without Docker)**

**Start Redis & Postgres:**
```bash
docker-compose up redis postgres -d
```

**Run Message Service:**
```bash
cd message-service
go run main.go
```

**Run Gateway:**
```bash
cd gateway
GATEWAY_ADDR=localhost:8080 \
GATEWAY_GRPC_ADDR=localhost:9000 \
go run main.go
```

**Run Web Client:**
```bash
cd web-client
node server.js
```

---

## 🧹 **Cleanup**

```bash
# Stop all services
docker-compose down -v

# Remove all experiment data
rm -rf results/experiment*/
```

---

## 🐛 **Troubleshooting**

**Q: Gateway won't start?**
```bash
# Check if Redis is running
docker-compose exec redis redis-cli PING
```

**Q: Messages not routing across gateways?**
```bash
# Check presence registry
docker-compose exec redis redis-cli HGETALL gateways
docker-compose exec redis redis-cli GET "presence:alice"
```

**Q: PTS not incrementing?**
```bash
# Check Redis counter
docker-compose exec redis redis-cli GET "user:alice:pts"
```

**Q: getDiff not returning messages?**
```bash
# Check Postgres
docker-compose exec postgres psql -U tt_user -d tinytelegram \
  -c "SELECT * FROM messages WHERE receiver_id='alice' ORDER BY receiver_pts;"
```

---

## 📊 **Demo Scenarios**

### **Demo 1: Cross-Gateway Messaging**
1. Start 2 gateways: `docker-compose up`
2. Open 2 browser tabs with different users
3. Send messages between them
4. **Observe**: gRPC routing logs in `docker-compose logs gateway1`

### **Demo 2: Multi-Device Sync**
1. Open 3 tabs as the same user
2. Send message from tab 1
3. **Observe**: Instant sync across all tabs with same PTS

### **Demo 3: Gateway Failover**
1. Connect user to gateway1
2. Run: `docker-compose stop gateway1`
3. **Observe**: Auto-reconnect to gateway2, getDiff recovery

### **Demo 4: Offline Recovery**
1. Connect user, note local PTS
2. Disconnect (browser offline mode)
3. Send messages to this user from another client
4. Reconnect
5. **Observe**: Waterfall of missed messages via getDiff

---

## 📚 **Related Work**

- **Telegram MTProto**: Split gateway architecture, consistent hashing
- **Redis**: Atomic INCR for distributed counters (alternative to Raft/Paxos)
- **CAP Theorem**: CP system design (consistency over availability under partition)
- **Lamport Clocks**: PTS provides per-user causal ordering

---

## 👥 **Team**

- **Shixian (Emily) Chen**: System scaling, experiment 2 (bottleneck analysis), experiment 4 (consistency validation)
- **Fazheng Han**: Core architecture, gRPC mesh, experiment 1 (gateway scaling), experiment 3 (failover)

**AI Contributions**: ~30% of code lines (scaffolding, boilerplate, test scripts). All architectural decisions and consistency-critical paths were human-designed and reviewed.

---

## 📄 **License**

MIT License - see [LICENSE](./LICENSE)

---

## 🚀 **Future Work**

- [ ] Full getDiff WebSocket/HTTP exposure for client-side recovery
- [ ] User authentication & authorization
- [ ] End-to-end encryption
- [ ] Group chats (broadcast PTS mechanism)
- [ ] Kubernetes deployment with auto-scaling
- [ ] Prometheus + Grafana monitoring dashboard
- [ ] Read receipts & typing indicators
- [ ] Mobile clients (iOS/Android)
- [ ] Multi-region replication

---

**Questions?** Check the [Design Document](./TinyTelegram-Design-Document.md) or open an issue.
