#!/usr/bin/env python3
import pandas as pd
import matplotlib.pyplot as plt
import json
import sys
from pathlib import Path

def plot_failover_results(results_dir):
    results_path = Path(results_dir)

    # Set up the plot style
    plt.style.use('seaborn-v0_8-darkgrid')
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))
    fig.suptitle('TinyTelegram Experiment 3: Gateway Failover & Recovery', fontsize=16, fontweight='bold')

    # Load metrics CSV
    metrics_file = results_path / 'failover_metrics.csv'
    if metrics_file.exists():
        df = pd.read_csv(metrics_file)
        # Convert connection columns to numeric, replacing non-numeric with 0
        df['connections_gw1'] = pd.to_numeric(df['connections_gw1'], errors='coerce').fillna(0)
        df['connections_gw2'] = pd.to_numeric(df['connections_gw2'], errors='coerce').fillna(0)
        df['connections_gw3'] = pd.to_numeric(df['connections_gw3'], errors='coerce').fillna(0)
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')

        # Find failover event
        failover_idx = df[df['event'] == 'failover'].index
        failover_time = df.loc[failover_idx[0], 'timestamp'] if len(failover_idx) > 0 else None

        # Plot 1: Total Active Connections Over Time
        ax1 = axes[0, 0]
        df['total_connections'] = df['connections_gw1'] + df['connections_gw2'] + df['connections_gw3']
        ax1.plot(df['timestamp'], df['total_connections'], label='Total Connections', color='#2563eb', linewidth=2)

        if failover_time:
            ax1.axvline(failover_time, color='red', linestyle='--', linewidth=2, label='Gateway1 Killed')

        ax1.set_xlabel('Time')
        ax1.set_ylabel('Active Connections')
        ax1.set_title('Total Active Connections During Failover')
        ax1.legend()
        ax1.grid(True, alpha=0.3)

        # Plot 2: Per-Gateway Connection Distribution
        ax2 = axes[0, 1]
        ax2.plot(df['timestamp'], df['connections_gw1'], label='Gateway 1', color='#10b981', linewidth=2)
        ax2.plot(df['timestamp'], df['connections_gw2'], label='Gateway 2', color='#f59e0b', linewidth=2)
        ax2.plot(df['timestamp'], df['connections_gw3'], label='Gateway 3', color='#8b5cf6', linewidth=2)

        if failover_time:
            ax2.axvline(failover_time, color='red', linestyle='--', linewidth=2, alpha=0.7)

        ax2.set_xlabel('Time')
        ax2.set_ylabel('Connections per Gateway')
        ax2.set_title('Connection Distribution Across Gateways')
        ax2.legend()
        ax2.grid(True, alpha=0.3)

    # Load k6 JSON results
    k6_file = results_path / 'failover_k6.json'
    if k6_file.exists():
        with open(k6_file, 'r') as f:
            k6_data = [json.loads(line) for line in f if line.strip()]

        # Extract reconnection times
        reconnect_times = []
        for entry in k6_data:
            if entry.get('type') == 'Point' and entry.get('metric') == 'reconnect_time_ms':
                reconnect_times.append(entry['data']['value'])

        if reconnect_times:
            # Plot 3: Reconnection Time Distribution
            ax3 = axes[1, 0]
            ax3.hist(reconnect_times, bins=30, color='#8b5cf6', alpha=0.7, edgecolor='black')
            ax3.axvline(sum(reconnect_times)/len(reconnect_times), color='red', linestyle='--',
                       linewidth=2, label=f'Mean: {sum(reconnect_times)/len(reconnect_times):.0f}ms')
            ax3.set_xlabel('Reconnection Time (ms)')
            ax3.set_ylabel('Frequency')
            ax3.set_title('Reconnection Time Distribution')
            ax3.legend()
            ax3.grid(True, alpha=0.3)

            # Plot 4: Reconnection Time CDF
            ax4 = axes[1, 1]
            sorted_times = sorted(reconnect_times)
            cdf = [i / len(sorted_times) for i in range(1, len(sorted_times) + 1)]
            ax4.plot(sorted_times, cdf, color='#2563eb', linewidth=2)
            ax4.set_xlabel('Reconnection Time (ms)')
            ax4.set_ylabel('Cumulative Probability')
            ax4.set_title('Reconnection Time CDF')
            ax4.grid(True, alpha=0.3)

            # Add percentile markers
            p50 = sorted_times[len(sorted_times)//2]
            p95 = sorted_times[int(len(sorted_times)*0.95)]
            p99 = sorted_times[int(len(sorted_times)*0.99)]
            ax4.axhline(0.50, color='green', linestyle=':', alpha=0.5)
            ax4.axhline(0.95, color='orange', linestyle=':', alpha=0.5)
            ax4.axhline(0.99, color='red', linestyle=':', alpha=0.5)
            ax4.text(sorted_times[-1]*0.7, 0.52, f'p50: {p50:.0f}ms', fontsize=9)
            ax4.text(sorted_times[-1]*0.7, 0.97, f'p95: {p95:.0f}ms', fontsize=9)
            ax4.text(sorted_times[-1]*0.7, 1.01, f'p99: {p99:.0f}ms', fontsize=9, va='bottom')

    plt.tight_layout()
    output_file = results_path / 'failover_results.png'
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"Plot saved to: {output_file}")

if __name__ == '__main__':
    results_dir = sys.argv[1] if len(sys.argv) > 1 else '../../results/experiment3'
    plot_failover_results(results_dir)
