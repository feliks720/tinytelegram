import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const redisLatency = new Trend('redis_only_latency');
const fullLatency = new Trend('full_write_latency');

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '60s', target: 100 },
    { duration: '30s', target: 0 },
  ],
};

export function setup() {
  return {};
}

export default function () {
  // Test 1: Redis only
  const redisRes = http.get('http://localhost:9090/redis-only');
  redisLatency.add(redisRes.timings.duration);
  check(redisRes, { 'redis status 200': (r) => r.status === 200 });

  sleep(0.05);

  // Test 2: Full write path (Redis + Postgres)
  const payload = JSON.stringify({
    sender_id: `user_${__VU}`,
    receiver_id: `user_${__VU + 1}`,
    content: `bottleneck test message`,
  });
  const fullRes = http.post('http://localhost:9090/message', payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  fullLatency.add(fullRes.timings.duration);
  check(fullRes, { 'full write status 200': (r) => r.status === 200 });

  sleep(0.05);
}
