# TinyTelegram Testing Guide

**Quick reference for running demos and experiments.**

---

## 🚀 **1-Minute Quick Test**

```bash
# Start system
docker-compose up -d --build

# Wait for startup
sleep 15

# Start web client
cd web-client && node server.js &

# Open browser
open http://localhost:3000
```

**In Browser:**
1. User ID: `alice`
2. Click "Connect"
3. Receiver ID: `bob`
4. Type message and send
5. ✅ You should see the acknowledgment with PTS value

---

## 🎬 **Demo Scenarios (For Presentation)**

### **Demo 1: Basic Messaging (2 min)**

```bash
# Terminal 1
docker-compose up -d
cd web-client && node server.js

# Open 2 browser tabs:
# Tab 1: Connect as "alice"
# Tab 2: Connect as "bob"

# alice → Send to bob: "Hello!"
# bob → See message appear instantly
# ✅ Shows: WebSocket communication, cross-user routing
```

---

### **Demo 2: Multi-Device Sync (3 min)**

```bash
# Open 3 browser tabs, all as "alice"
# Tab 1: Send message to bob
# ✅ Shows: All 3 tabs receive same message with identical PTS
# Demonstrates: Multi-device synchronization via PTS
```

---

### **Demo 3: Gateway Failover (5 min)**

```bash
# Terminal 1: Start system
docker-compose up -d

# Terminal 2: Start web client
cd web-client && node server.js

# Browser: Connect as "alice"

# Terminal 3: Kill gateway while chatting
docker-compose stop gateway1

# ✅ Browser auto-reconnects to gateway2
# ✅ No messages lost (getDiff recovery)
```

---

### **Demo 4: Consistent Hashing (5 min)**

```bash
# Start with 3 gateways
docker-compose -f infra/docker-compose.3gw.yml up -d

# Open 6 tabs with users: alice, bob, charlie, dave, eve, frank
# Check which gateway each connected to:
docker-compose -f infra/docker-compose.3gw.yml exec gateway1 wget -qO- http://localhost:8080/metrics
docker-compose -f infra/docker-compose.3gw.yml exec gateway2 wget -qO- http://localhost:8080/metrics
docker-compose -f infra/docker-compose.3gw.yml exec gateway3 wget -qO- http://localhost:8080/metrics

# ✅ Shows: Users distributed across gateways
# ✅ Same user always goes to same gateway (sticky sessions)
```

---

## 🧪 **Running Experiments**

### **Experiment 1: Gateway Scaling (15 min)**

```bash
cd scripts/experiment1
./run_all.sh

# This will:
# - Test 1, 3, and 5 gateways sequentially
# - Run k6 load test with 100→500→1000→2000 VUs
# - Collect metrics every 3 seconds
# - Generate results in results/experiment1/

# View results:
ls -lh ../../results/experiment1/

# Plot results:
python3 plot_results.py ../../results/experiment1
open ../../results/experiment1/experiment1_results.png
```

**Expected Output:**
- CSV files with metrics
- PNG graph showing linear memory scaling
- k6 summary with connection stats

---

### **Experiment 2: Bottleneck Analysis (10 min)**

**Note:** Experiment 2 tests were run in March. To re-run, you need to add HTTP endpoints. For demo purposes, show existing results:

```bash
open results/experiment2/experiment2_results.png
```

**Key Finding:** Redis INCR avg 0.69ms, Postgres INSERT avg 3.1ms. Redis is not the bottleneck.

**To re-run (requires code changes):**
```bash
# Add HTTP endpoint wrapper first (see README troubleshooting)
cd scripts/experiment2
k6 run load_test.js
k6 run bottleneck_test.js
python3 plot_results.py ../../results/experiment2
```

---

### **Experiment 3: Failover Recovery (10 min)**

```bash
cd scripts/experiment3
./run_failover.sh

# This will:
# 1. Start 3 gateways
# 2. Establish 50 WebSocket connections (30s baseline)
# 3. Kill gateway1
# 4. Measure reconnection time and message recovery
# 5. Generate results in results/experiment3/

# Plot results:
python3 plot_failover.py ../../results/experiment3
open ../../results/experiment3/failover_results.png
```

**Pass Criteria:**
- ✅ p95 reconnection < 5s
- ✅ All connections redistributed to gateway2/3
- ✅ 0 messages lost (via getDiff)

---

### **Experiment 4: Consistency Validation (10 min)**

```bash
cd scripts/experiment4
./run_consistency.sh

# This will:
# 1. Start system with 50 concurrent users
# 2. Run for 90s (normal operation)
# 3. Restart message-service (simulate crash)
# 4. Run for 60s (post-crash validation)
# 5. Analyze PTS ordering from Redis and Postgres

# Plot results:
python3 plot_consistency.py ../../results/experiment4
open ../../results/experiment4/consistency_results.png
```

**Pass Criteria:**
- ✅ Zero PTS ordering violations
- ✅ Consistency score > 99%
- ✅ All gaps detected and recoverable

---

## 🐛 **Quick Debugging**

### **Check if services are running:**
```bash
docker-compose ps
```

### **Check gateway connections:**
```bash
# Gateway 1 metrics
curl http://localhost:8080/metrics | jq

# Gateway 2 metrics (if running multi-gateway)
docker-compose exec gateway2 wget -qO- http://localhost:8080/metrics | jq
```

### **Check Redis presence:**
```bash
# See all registered gateways
docker-compose exec redis redis-cli HGETALL gateways

# Check user presence
docker-compose exec redis redis-cli GET "presence:alice"

# Check PTS counter
docker-compose exec redis redis-cli GET "user:alice:pts"
```

### **Check Postgres messages:**
```bash
docker-compose exec postgres psql -U tt_user -d tinytelegram \
  -c "SELECT sender_id, receiver_id, sender_pts, receiver_pts, content FROM messages ORDER BY receiver_pts DESC LIMIT 10;"
```

### **View logs:**
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f gateway1
docker-compose logs -f message-service
```

---

## 📊 **Expected Results Summary**

| Experiment | Key Metric | Expected Value | Validates |
|------------|-----------|----------------|-----------|
| **Exp 1** | Memory per gateway | ~10-12MB @ 2000 conns | Linear scaling via consistent hashing |
| **Exp 2** | Redis INCR latency | ~1ms (p95) | Redis is fast, not bottleneck |
| **Exp 2** | Full write path | ~57ms (p95) | Postgres is bottleneck under load |
| **Exp 3** | Reconnection time | <5s (p95) | Fast failover recovery |
| **Exp 3** | Message loss | 0 (via getDiff) | Fault tolerance guarantees |
| **Exp 4** | PTS violations | 0 | Strict ordering maintained |
| **Exp 4** | Consistency score | >99% | CP guarantees under failure |

---

## 🎓 **For Your Presentation**

### **Slide 1: Architecture Overview**
Show the architecture diagram from README.

### **Slide 2: Live Demo**
Run **Demo 2** (Multi-device sync) - it's the most impressive.

### **Slide 3: Experiment 1 Results**
Show graph: `results/experiment1/experiment1_results.png`
**Key point:** Linear memory scaling confirms consistent hashing works.

### **Slide 4: Experiment 2 Results**
Show graph: `results/experiment2/experiment2_results.png`
**Key point:** Redis atomic INCR is sub-millisecond, Postgres is bottleneck.

### **Slide 5: Experiment 3 Results**
Show graph: `results/experiment3/failover_results.png`
**Key point:** p95 reconnection under 5s, zero message loss via getDiff.

### **Slide 6: Experiment 4 Results**
Show graph: `results/experiment4/consistency_results.png`
**Key point:** Zero PTS violations = strict causal ordering maintained.

### **Slide 7: Distributed Systems Concepts**
- Consistent hashing (gateway assignment)
- Redis INCR for distributed counters (no Raft needed)
- Incremental sync (getDiff = log-based replication)
- CP system (consistency over availability)

---

## ⏱️ **Time Estimates**

- **Basic system test**: 5 minutes
- **All 4 demos**: 15 minutes
- **Run Experiment 1**: 15 minutes
- **Run Experiment 3**: 10 minutes
- **Run Experiment 4**: 10 minutes
- **Generate all plots**: 5 minutes

**Total time to fully test everything**: ~60 minutes

---

## 📝 **Checklist Before Submission**

- [ ] README.md is complete
- [ ] All 4 experiments have results
- [ ] Web client works in browser
- [ ] Design document is up to date
- [ ] At least 3 experiments have plots/graphs
- [ ] docker-compose up works cleanly
- [ ] Code is pushed to GitHub
- [ ] Report PDF is in repo

---

## 🎯 **Quick Commands Cheat Sheet**

```bash
# Start system
docker-compose up -d --build

# Stop system
docker-compose down -v

# View logs
docker-compose logs -f gateway1

# Run Experiment 3
cd scripts/experiment3 && ./run_failover.sh

# Run Experiment 4
cd scripts/experiment4 && ./run_consistency.sh

# Start web client
cd web-client && node server.js

# Check gateway metrics
curl http://localhost:8080/metrics | jq '.active_connections'

# Check Redis PTS
docker-compose exec redis redis-cli GET "user:alice:pts"

# Query Postgres
docker-compose exec postgres psql -U tt_user -d tinytelegram -c "SELECT COUNT(*) FROM messages;"
```

---

**Good luck with your presentation! 🚀**
