import json
import matplotlib.pyplot as plt
import numpy as np

timestamps = []
durations = []

with open('scripts/results.json', 'r') as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get('type') == 'Point' and data.get('metric') == 'http_req_duration':
                t = data['data']['time']
                # parse ISO timestamp
                from datetime import datetime
                dt = datetime.fromisoformat(t.replace('Z', '+00:00'))
                timestamps.append(dt.timestamp())
                durations.append(data['data']['value'])
        except:
            continue

print(f"Loaded {len(timestamps)} data points")

if not timestamps:
    print("No data found, check results.json format")
    exit()

t0 = min(timestamps)
rel_times = [t - t0 for t in timestamps]

# Bin into 5-second windows
max_t = max(rel_times)
bins = np.arange(0, max_t + 5, 5)
p50_bins, p95_bins, p99_bins, bin_centers = [], [], [], []

for i in range(len(bins) - 1):
    window = [d for d, t in zip(durations, rel_times) if bins[i] <= t < bins[i+1]]
    if window:
        p50_bins.append(np.percentile(window, 50))
        p95_bins.append(np.percentile(window, 95))
        p99_bins.append(np.percentile(window, 99))
        bin_centers.append((bins[i] + bins[i+1]) / 2)

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 10))
fig.suptitle('TinyTelegram Experiment 2: Message Write Path Latency Under Load',
             fontsize=13, fontweight='bold')

# Latency over time
ax1.plot(bin_centers, p50_bins, label='p50', color='#2ecc71', linewidth=2)
ax1.plot(bin_centers, p95_bins, label='p95', color='#f39c12', linewidth=2)
ax1.plot(bin_centers, p99_bins, label='p99', color='#e74c3c', linewidth=2)
ax1.axhline(y=2000, color='red', linestyle='--', alpha=0.5, label='SLO (2000ms)')
ax1.axvline(x=30, color='gray', linestyle=':', alpha=0.7)
ax1.axvline(x=90, color='gray', linestyle=':', alpha=0.7)
ax1.axvline(x=150, color='gray', linestyle=':', alpha=0.7)
ax1.text(15, max(p99_bins)*0.9, '10 VUs', ha='center', color='gray', fontsize=9)
ax1.text(60, max(p99_bins)*0.9, '50 VUs', ha='center', color='gray', fontsize=9)
ax1.text(120, max(p99_bins)*0.9, '100 VUs', ha='center', color='gray', fontsize=9)
ax1.set_xlabel('Time (seconds)')
ax1.set_ylabel('Latency (ms)')
ax1.set_title('Request Latency Over Time (p50 / p95 / p99)')
ax1.legend()
ax1.grid(alpha=0.3)

# Summary bar chart
categories = ['p50', 'p90', 'p95', 'p99', 'max']
values = [1.52, 21.66, 57.3, 236.11, 1439.9]
colors = ['#2ecc71', '#3498db', '#f39c12', '#e74c3c', '#8e44ad']
bars = ax2.bar(categories, values, color=colors, width=0.5)
ax2.axhline(y=2000, color='red', linestyle='--', alpha=0.7, label='SLO (2000ms)')
for bar, val in zip(bars, values):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 10,
             f'{val:.1f}ms', ha='center', va='bottom', fontweight='bold')
ax2.set_ylabel('Latency (ms)')
ax2.set_title('Overall Latency Distribution (100 VUs, 69,070 requests, 0% error rate)')
ax2.legend()
ax2.grid(axis='y', alpha=0.3)

plt.tight_layout()
plt.savefig('scripts/experiment2_results.png', dpi=150, bbox_inches='tight')
print("Saved!")
plt.close()
