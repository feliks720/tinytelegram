import os
import sys

import matplotlib.pyplot as plt
import pandas as pd


results_dir = sys.argv[1] if len(sys.argv) > 1 else "../../results/experiment1"

fig, axes = plt.subplots(2, 2, figsize=(14, 10))
fig.suptitle("Experiment 1: Gateway Horizontal Scaling", fontsize=16)

colors = {1: "#e74c3c", 3: "#3498db", 5: "#2ecc71"}

for num_gw in [1, 3, 5]:
    metrics_file = os.path.join(results_dir, f"{num_gw}gw_metrics.csv")
    if not os.path.exists(metrics_file):
        print(f"Skipping {num_gw}gw (no data)")
        continue

    df = pd.read_csv(metrics_file)
    df["elapsed"] = df["timestamp"] - df["timestamp"].min()

    agg = df.groupby("elapsed").agg({
        "active_connections": "sum",
        "goroutines": "sum",
        "heap_alloc_mb": "sum",
    }).reset_index()

    label = f"{num_gw} gateway(s)"
    color = colors[num_gw]

    axes[0, 0].plot(agg["elapsed"], agg["active_connections"], label=label, color=color)
    axes[0, 1].plot(agg["elapsed"], agg["goroutines"], label=label, color=color)
    axes[1, 0].plot(agg["elapsed"], agg["heap_alloc_mb"], label=label, color=color)

    for gateway in df["gateway"].unique():
        gw_df = df[df["gateway"] == gateway]
        axes[1, 1].plot(gw_df["elapsed"], gw_df["heap_alloc_mb"], label=f"{num_gw}gw-{gateway}", alpha=0.7)

axes[0, 0].set_title("Total Active Connections")
axes[0, 0].set_xlabel("Time (s)")
axes[0, 0].set_ylabel("Connections")
axes[0, 0].legend()

axes[0, 1].set_title("Total Goroutines")
axes[0, 1].set_xlabel("Time (s)")
axes[0, 1].set_ylabel("Goroutines")
axes[0, 1].legend()

axes[1, 0].set_title("Total Heap Memory (MB)")
axes[1, 0].set_xlabel("Time (s)")
axes[1, 0].set_ylabel("MB")
axes[1, 0].legend()

axes[1, 1].set_title("Per-Gateway Heap Memory (MB)")
axes[1, 1].set_xlabel("Time (s)")
axes[1, 1].set_ylabel("MB")
axes[1, 1].legend(fontsize=7)

plt.tight_layout()
output = os.path.join(results_dir, "experiment1_results.png")
plt.savefig(output, dpi=150)
print(f"Plot saved to {output}")
