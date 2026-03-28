import matplotlib.pyplot as plt
import numpy as np

metrics = ['avg', 'p50\n(median)', 'p90', 'p95', 'max']
redis_vals = [0.69, 0.41, 0.91, 1.43, 57.19]
full_vals  = [3.10, 1.17, 6.41, 9.51, 141.56]
postgres_overhead = [f - r for f, r in zip(full_vals, redis_vals)]

x = np.arange(len(metrics))
width = 0.3

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))
fig.suptitle('TinyTelegram Experiment 2: Redis INCR vs Postgres Write Bottleneck Analysis',
             fontsize=13, fontweight='bold')

# Stacked bar: Redis vs Postgres overhead
ax1.bar(x, redis_vals, width, label='Redis INCR', color='#2ecc71')
ax1.bar(x, postgres_overhead, width, bottom=redis_vals, label='Postgres INSERT overhead', color='#e74c3c')
for i, (r, p) in enumerate(zip(redis_vals, full_vals)):
    ax1.text(i, p + 1, f'{p:.1f}ms', ha='center', va='bottom', fontsize=9, fontweight='bold')
ax1.set_xticks(x)
ax1.set_xticklabels(metrics)
ax1.set_ylabel('Latency (ms)')
ax1.set_title('Write Path Breakdown: Redis vs Postgres')
ax1.legend()
ax1.grid(axis='y', alpha=0.3)

# Side by side comparison
bars1 = ax2.bar(x - width/2, redis_vals, width, label='Redis only', color='#2ecc71')
bars2 = ax2.bar(x + width/2, full_vals, width, label='Full write (Redis + Postgres)', color='#3498db')
ax2.set_xticks(x)
ax2.set_xticklabels(metrics)
ax2.set_ylabel('Latency (ms)')
ax2.set_title('Redis Only vs Full Write Path')
ax2.legend()
ax2.grid(axis='y', alpha=0.3)

plt.tight_layout()
plt.savefig('scripts/bottleneck_results.png', dpi=150, bbox_inches='tight')
print("Saved!")
plt.close()
