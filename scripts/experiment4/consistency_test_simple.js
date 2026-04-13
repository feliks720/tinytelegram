import ws from 'k6/ws';
import { sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const ptsGapsDetected = new Counter('pts_gaps_detected');
const messagesReceived = new Counter('messages_received');
const messagesSent = new Counter('messages_sent');

export const options = {
  scenarios: {
    normal: {
      executor: 'constant-vus',
      vus: 50,
      duration: '150s',
    },
  },
};

const BASE_URL = __ENV.WS_URL || 'ws://localhost:8080';

export default function () {
  const userId = `user_consist_${__VU}`;
  const receiverId = `user_consist_${(__VU % 10) + 1}`;
  const url = `${BASE_URL}/ws?user_id=${userId}`;

  let localPts = 0;

  ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.setInterval(function () {
        socket.send(JSON.stringify({
          receiver_id: receiverId,
          content: `test_${Date.now()}`,
        }));
        messagesSent.add(1);
      }, 3000);
    });

    socket.on('message', function (data) {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === 'ack' && msg.sender_pts) {
          if (msg.sender_pts > localPts + 1) {
            ptsGapsDetected.add(1);
          }
          localPts = msg.sender_pts;
        }
        
        if (msg.message) {
          messagesReceived.add(1);
        }
      } catch (e) {}
    });

    sleep(150);
  });
}
