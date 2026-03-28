import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const latency = new Trend('message_latency');

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // ramp up to 10 users
    { duration: '60s', target: 50 },   // ramp up to 50 users
    { duration: '60s', target: 100 },  // ramp up to 100 users
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<2000'], // p99 under 2s
    http_req_failed: ['rate<0.01'],    // error rate under 1%
  },
};

export default function () {
  const payload = JSON.stringify({
    sender_id: `user_${__VU}`,
    receiver_id: `user_${__VU + 1}`,
    content: `message from VU ${__VU} iter ${__ITER}`,
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  const res = http.post('http://localhost:9090/message', payload, params);

  latency.add(res.timings.duration);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has pts': (r) => JSON.parse(r.body).pts > 0,
  });

  sleep(0.1);
}
