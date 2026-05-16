export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function smooth(previous: number, next: number, alpha = 0.34): number {
  if (previous === 0) {
    return next;
  }
  return previous * (1 - alpha) + next * alpha;
}

export function percentile95(latencies: number[]): number {
  if (latencies.length === 0) {
    return 0;
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] ?? 0;
}
