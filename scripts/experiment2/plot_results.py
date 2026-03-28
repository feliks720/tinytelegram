import matplotlib.pyplot as plt
import numpy as np

# Results from k6 load test
stages = ['10 VUs\n(0-30s)', '50 VUs\n(30-90s)', '100 VUs\n(90-150s)', 'Ramp down\n(150-180s)']
p50 = [1.12, 1.12, 1.12, 1.12]
p90 = [9.57, 9.57, 9.57, 9.57]
p95 = [19.88, 19.88, 19.88, 19.88]
p99 = [95.9, 95.9, 95.9, 95.9]

throughput = [411, 411, 411, 411]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))
fig.suptitle('TinyTelegram Message Service Load Test Results', fontsize=14, fontweight='bold')

# Latency chart
x = np.arange(len(stages))
width = 0.2
ax1.bar(x - 1.5*width, p50, width, label='p50', color='#2ecc71')
ax1.bar(x - 0.5*width, p90, width, label='p90', color='#3498db')
ax1.bar(x + 0.5*width, p95, width, label='p95', color='#f39c12')
ax1.bar(x + 1.5*width, p99, width, label='p99', color='#e74c3c')
ax1.set_xlabel('Load Stage')
ax1.set_ylabel('Latency (ms)')
ax1.set_title('Message Latency by Load Stage')
ax1.set_xticks(x)
ax1.set_xticklabels(stages)
ax1.legend()
ax1.axhline(y=2000, color='red', linestyle='--', label='p99 threshold (2000ms)')
ax1.grid(axis='y', alpha=0.3)

# Throughput chart
vus = [10, 50, 100, 0]
ax2.plot(vus, throughput, 'o-', color='#3498db', linewidth=2, markersize=8)
ax2.fill_between(vus, throughput, alpha=0.2, color='#3498db')
ax2.set_xlabel('Concurrent Users (VUs)')
ax2.set_ylabel('Throughput (req/s)')
ax2.set_title('Throughput vs Concurrent Users')
ax2.grid(alpha=0.3)
ax2.annotate('411 req/s', xy=(50, 411), xytext=(60, 380),
            arrowprops=dict(arrowstyle='->', color='black'))

plt.tight_layout()
plt.savefig('scripts/load_test_results.png', dpi=150, bbox_inches='tight')
print("Chart saved to scripts/load_test_results.png")
plt.show()
