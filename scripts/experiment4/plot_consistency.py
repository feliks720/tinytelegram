#!/usr/bin/env python3
import pandas as pd
import matplotlib.pyplot as plt
import json
import sys
from pathlib import Path

def plot_consistency_results(results_dir):
    results_path = Path(results_dir)

    plt.style.use('seaborn-v0_8-darkgrid')
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))
    fig.suptitle('TinyTelegram Experiment 4: Consistency Validation & PTS Ordering', fontsize=16, fontweight='bold')

    # Load metrics CSV
    metrics_file = results_path / 'consistency_metrics.csv'
    if metrics_file.exists():
        df = pd.read_csv(metrics_file)
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='s')

        # Find crash event
        crash_idx = df[df['phase'] == 'crash'].index
        crash_time = df.loc[crash_idx[0], 'timestamp'] if len(crash_idx) > 0 else None

        # Plot 1: PTS Growth Over Time
        ax1 = axes[0, 0]
        ax1.plot(df['timestamp'], df['redis_pts_user1'], label='User 1 PTS', color='#2563eb', linewidth=2)
        ax1.plot(df['timestamp'], df['redis_pts_user2'], label='User 2 PTS', color='#10b981', linewidth=2)

        if crash_time:
            ax1.axvline(crash_time, color='red', linestyle='--', linewidth=2, label='Service Restart')

        ax1.set_xlabel('Time')
        ax1.set_ylabel('PTS Value')
        ax1.set_title('PTS Growth Over Time (Redis INCR)')
        ax1.legend()
        ax1.grid(True, alpha=0.3)

        # Plot 2: Message Count Growth
        ax2 = axes[0, 1]
        ax2.plot(df['timestamp'], df['pg_message_count'], label='Total Messages (Postgres)', color='#8b5cf6', linewidth=2)

        if crash_time:
            ax2.axvline(crash_time, color='red', linestyle='--', linewidth=2, alpha=0.7)

        ax2.set_xlabel('Time')
        ax2.set_ylabel('Message Count')
        ax2.set_title('Persisted Message Count Over Time')
        ax2.legend()
        ax2.grid(True, alpha=0.3)

    # Load k6 JSON results
    k6_file = results_path / 'consistency_k6.json'
    if k6_file.exists():
        with open(k6_file, 'r') as f:
            k6_data = [json.loads(line) for line in f if line.strip()]

        # Extract PTS gap sizes
        gap_sizes = []
        for entry in k6_data:
            if entry.get('type') == 'Point' and entry.get('metric') == 'pts_gap_size':
                gap_sizes.append(entry['data']['value'])

        # Count order violations and other issues
        order_violations = sum(1 for e in k6_data
                              if e.get('type') == 'Point' and e.get('metric') == 'pts_order_violations')

        gaps_detected = sum(1 for e in k6_data
                           if e.get('type') == 'Point' and e.get('metric') == 'pts_gaps_detected')

        duplicates = sum(1 for e in k6_data
                        if e.get('type') == 'Point' and e.get('metric') == 'duplicate_messages')

        # Plot 3: PTS Gap Size Distribution
        ax3 = axes[1, 0]
        if gap_sizes:
            ax3.hist(gap_sizes, bins=20, color='#f59e0b', alpha=0.7, edgecolor='black')
            ax3.axvline(sum(gap_sizes)/len(gap_sizes), color='red', linestyle='--',
                       linewidth=2, label=f'Mean: {sum(gap_sizes)/len(gap_sizes):.1f}')
            ax3.set_xlabel('Gap Size (missed messages)')
            ax3.set_ylabel('Frequency')
            ax3.set_title(f'PTS Gap Distribution ({len(gap_sizes)} gaps detected)')
            ax3.legend()
        else:
            ax3.text(0.5, 0.5, 'No PTS gaps detected\n✓ Perfect ordering',
                    ha='center', va='center', fontsize=14, color='green', fontweight='bold')
            ax3.set_title('PTS Gap Distribution')
        ax3.grid(True, alpha=0.3)

        # Plot 4: Consistency Summary
        ax4 = axes[1, 1]
        ax4.axis('off')

        summary_text = "Consistency Validation Summary\n"
        summary_text += "=" * 40 + "\n\n"

        summary_text += f"PTS Order Violations: {order_violations}\n"
        if order_violations == 0:
            summary_text += "  ✓ PASS: Strict ordering maintained\n\n"
        else:
            summary_text += "  ✗ FAIL: Ordering guarantees broken\n\n"

        summary_text += f"PTS Gaps Detected: {gaps_detected}\n"
        if gaps_detected > 0 and gap_sizes:
            summary_text += f"  Average Gap Size: {sum(gap_sizes)/len(gap_sizes):.2f}\n"
            summary_text += f"  Max Gap Size: {max(gap_sizes)}\n"
            summary_text += "  (Gaps trigger getDiff recovery)\n\n"
        else:
            summary_text += "  ✓ No gaps (perfect continuity)\n\n"

        summary_text += f"Duplicate Messages: {duplicates}\n"
        if duplicates == 0:
            summary_text += "  ✓ No duplicates detected\n\n"
        else:
            summary_text += f"  (Handled by client-side dedup)\n\n"

        summary_text += "\n" + "=" * 40 + "\n"
        summary_text += "VERDICT:\n"
        if order_violations == 0:
            summary_text += "✓ Redis INCR maintains strict\n"
            summary_text += "  per-user causal ordering.\n"
            summary_text += "  CP guarantees preserved."
        else:
            summary_text += "✗ Consistency issues detected.\n"
            summary_text += "  Further investigation needed."

        ax4.text(0.1, 0.95, summary_text, fontsize=11, family='monospace',
                va='top', ha='left', bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.3))

    plt.tight_layout()
    output_file = results_path / 'consistency_results.png'
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"Plot saved to: {output_file}")

if __name__ == '__main__':
    results_dir = sys.argv[1] if len(sys.argv) > 1 else '../../results/experiment4'
    plot_consistency_results(results_dir)
