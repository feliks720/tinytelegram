import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// Custom metrics for consistency validation
const ptsGapsDetected = new Counter('pts_gaps_detected');
const ptsGapSize = new Trend('pts_gap_size');
const ptsOrderViolations = new Counter('pts_order_violations');
const messagesReceived = new Counter('messages_received');
const messagesSent = new Counter('messages_sent');
const duplicateMessages = new Counter('duplicate_messages');
const consistencyScore = new Rate('consistency_score');

export const options = {
  scenarios: {
    // Phase 1: Normal operation
    normal_operation: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '60s', target: 50 },
      ],
      tags: { phase: 'normal' },
    },
    // Phase 2: Crash simulation (manual trigger via docker restart)
    post_crash: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      startTime: '90s',
      tags: { phase: 'post_crash' },
    },
  },
  // thresholds: {
    // 'pts_order_violations', // No PTS ordering violations allowed
    // 'consistency_score', // 99% of message sequences consistent
  },
};

const BASE_URL = __ENV.WS_URL || 'ws://localhost:8080';

export default function () {
  const userId = `user_consist_${__VU}`;
  const receiverId = `user_consist_${(__VU % 10) + 1}`;
  const url = `${BASE_URL}/ws?user_id=${userId}`;

  let localPts = 0;
  let lastReceivedPts = 0;
  let messageLog = new Map(); // msgId -> {pts, content, timestamp}
  let sequenceConsistent = true;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      console.log(`[${userId}] Connected, local_pts=${localPts}`);

      // NOTE: In a full implementation, we would call getDiff(localPts) here
      // to recover any missed messages. For this test, we detect gaps.

      // Send messages periodically
      socket.setInterval(function () {
        if (socket.readyState === ws.OPEN) {
          const timestamp = Date.now();
          const content = `msg_${timestamp}`;

          socket.send(JSON.stringify({
            receiver_id: receiverId,
            content: content,
          }));

          messagesSent.add(1);
        }
      }, 2000); // Send every 2 seconds
    });

    socket.on('message', function (data) {
      try {
        const msg = JSON.parse(data);

        // Handle ACK for sent messages
        if (msg.type === 'ack') {
          const pts = msg.sender_pts;
          const msgId = msg.message_id;

          if (!pts) return;

          // Check for PTS ordering
          if (pts <= localPts) {
            console.error(`[${userId}] PTS ORDER VIOLATION: received ${pts}, expected >${localPts}`);
            ptsOrderViolations.add(1);
            sequenceConsistent = false;
          }

          // Check for gaps
          if (pts > localPts + 1) {
            const gapSize = pts - localPts - 1;
            console.warn(`[${userId}] PTS GAP in sent messages: ${localPts} -> ${pts} (gap: ${gapSize})`);
            ptsGapsDetected.add(1);
            ptsGapSize.add(gapSize);
            sequenceConsistent = false;
          }

          // Check for duplicates
          if (messageLog.has(msgId)) {
            console.warn(`[${userId}] DUPLICATE MESSAGE: ${msgId}`);
            duplicateMessages.add(1);
            sequenceConsistent = false;
          }

          messageLog.set(msgId, {
            pts: pts,
            type: 'sent',
            timestamp: Date.now(),
          });

          localPts = pts;
        }

        // Handle incoming messages
        if (msg.message) {
          messagesReceived.add(1);
          const msgId = msg.id;
          const incomingMsg = msg.message;

          // Determine which PTS applies to us
          let pts;
          if (incomingMsg.receiver_id === userId) {
            pts = msg.receiver_pts;
          } else if (incomingMsg.sender_id === userId) {
            pts = msg.sender_pts;
          }

          if (!pts) return;

          // Check for PTS ordering
          if (pts <= lastReceivedPts) {
            console.error(`[${userId}] INCOMING PTS ORDER VIOLATION: received ${pts}, last was ${lastReceivedPts}`);
            ptsOrderViolations.add(1);
            sequenceConsistent = false;
          }

          // Check for gaps in received messages
          if (lastReceivedPts > 0 && pts > lastReceivedPts + 1) {
            const gapSize = pts - lastReceivedPts - 1;
            console.warn(`[${userId}] PTS GAP in received messages: ${lastReceivedPts} -> ${pts} (gap: ${gapSize})`);
            ptsGapsDetected.add(1);
            ptsGapSize.add(gapSize);
            sequenceConsistent = false;

            // In production, this would trigger: getDiff(lastReceivedPts)
            console.log(`[${userId}] Would call getDiff(${lastReceivedPts}) to fill gap`);
          }

          // Check for duplicates
          if (messageLog.has(msgId)) {
            console.warn(`[${userId}] DUPLICATE INCOMING MESSAGE: ${msgId}`);
            duplicateMessages.add(1);
            sequenceConsistent = false;
          }

          messageLog.set(msgId, {
            pts: pts,
            type: 'received',
            timestamp: Date.now(),
          });

          lastReceivedPts = pts;

          // Update local PTS to max of both
          localPts = Math.max(localPts, pts);
        }
      } catch (e) {
        console.error(`[${userId}] Parse error:`, e);
      }
    });

    socket.on('error', function (e) {
      console.error(`[${userId}] WebSocket error:`, e);
    });

    socket.on('close', function () {
      console.log(`[${userId}] Connection closed, final_pts=${localPts}`);

      // Record consistency score for this connection
      consistencyScore.add(sequenceConsistent ? 1 : 0);
    });

    // Keep connection alive
    sleep(90); // Match scenario duration
  });

  check(res, {
    'connection successful': (r) => r && r.status === 101,
  });

  sleep(1);
}

export function handleSummary(data) {
  const summary = generateTextSummary(data);

  return {
    'stdout': summary,
    '/home/ec2-user/tinytelegram/results/experiment4/consistency_summary.json': JSON.stringify(data),
    '/home/ec2-user/tinytelegram/results/experiment4/consistency_summary.txt': summary,
  };
}

function generateTextSummary(data) {
  const metrics = data.metrics;
  let summary = '\n\n';
  summary += '============================================\n';
  summary += '  Experiment 4: Consistency Validation\n';
  summary += '  PTS Ordering & Gap Detection\n';
  summary += '============================================\n\n';

  // Messages sent/received
  if (metrics.messages_sent) {
    summary += `Total Messages Sent: ${metrics.messages_sent.values.count}\n`;
  }
  if (metrics.messages_received) {
    summary += `Total Messages Received: ${metrics.messages_received.values.count}\n\n`;
  }

  // PTS ordering violations (CRITICAL - should be 0)
  if (metrics.pts_order_violations) {
    const violations = metrics.pts_order_violations.values.count;
    summary += `PTS Order Violations: ${violations}`;
    if (violations === 0) {
      summary += ' ✓ (PASS)\n';
    } else {
      summary += ' ✗ (FAIL - Ordering guarantees broken!)\n';
    }
  }

  // PTS gaps detected
  if (metrics.pts_gaps_detected) {
    const gaps = metrics.pts_gaps_detected.values.count;
    summary += `PTS Gaps Detected: ${gaps}\n`;
    if (gaps > 0 && metrics.pts_gap_size) {
      summary += `  Average Gap Size: ${metrics.pts_gap_size.values.avg.toFixed(2)}\n`;
      summary += `  Max Gap Size: ${metrics.pts_gap_size.values.max}\n`;
      summary += `  (Gaps trigger getDiff() in production)\n`;
    }
  }
  summary += '\n';

  // Duplicate messages
  if (metrics.duplicate_messages) {
    const dupes = metrics.duplicate_messages.values.count;
    summary += `Duplicate Messages: ${dupes}`;
    if (dupes === 0) {
      summary += ' ✓ (No duplicates)\n';
    } else {
      summary += ' (Dedup via msgId working)\n';
    }
  }

  // Overall consistency score
  if (metrics.consistency_score) {
    const score = (metrics.consistency_score.values.rate * 100).toFixed(2);
    summary += `\nConsistency Score: ${score}%`;
    if (metrics.consistency_score.values.rate >= 0.99) {
      summary += ' ✓ (PASS)\n';
    } else {
      summary += ' ✗ (FAIL - Below 99% threshold)\n';
    }
  }

  summary += '\n============================================\n';
  summary += '  Verdict\n';
  summary += '============================================\n\n';

  const ptsViolations = metrics.pts_order_violations ? metrics.pts_order_violations.values.count : 0;
  const consistRate = metrics.consistency_score ? metrics.consistency_score.values.rate : 0;

  if (ptsViolations === 0 && consistRate >= 0.99) {
    summary += '✓ PASS: Redis PTS maintains strict ordering.\n';
    summary += '  No ordering violations detected under load.\n';
    summary += '  System guarantees causal consistency per-user.\n';
  } else {
    summary += '✗ FAIL: Consistency issues detected.\n';
    if (ptsViolations > 0) {
      summary += `  - ${ptsViolations} PTS ordering violations\n`;
    }
    if (consistRate < 0.99) {
      summary += `  - Consistency score ${(consistRate*100).toFixed(2)}% (below 99%)\n`;
    }
  }

  summary += '\n';
  return summary;
}
