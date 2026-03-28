import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const wsConnections = new Counter('ws_connections_total');
const wsConnectionsFailed = new Counter('ws_connections_failed');
const wsDropRate = new Rate('ws_drop_rate');

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '30s', target: 500 },
    { duration: '60s', target: 500 },
    { duration: '30s', target: 1000 },
    { duration: '60s', target: 1000 },
    { duration: '30s', target: 2000 },
    { duration: '60s', target: 2000 },
    { duration: '30s', target: 0 },
  ],
};

const BASE_URL = __ENV.WS_URL || 'ws://localhost:8080';

export default function () {
  const userId = `user_${__VU}_${__ITER}`;
  const receiverId = `user_${(__VU % 100) + 1}_0`;
  const url = `${BASE_URL}/ws?user_id=${userId}`;

  const res = ws.connect(url, {}, function (socket) {
    wsConnections.add(1);

    socket.on('open', function () {
      socket.setInterval(function () {
        socket.send(JSON.stringify({
          receiver_id: receiverId,
          content: `hello from ${userId} at ${Date.now()}`,
        }));
      }, 2000);
    });

    socket.on('error', function () {
      wsConnectionsFailed.add(1);
      wsDropRate.add(1);
    });

    socket.on('close', function () {
      wsDropRate.add(0);
    });

    sleep(10);
    socket.close();
  });

  check(res, {
    'WebSocket connected': (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    wsConnectionsFailed.add(1);
    wsDropRate.add(1);
  }
}
