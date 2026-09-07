const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

/**
 * Convert a byte count into a human-readable string (base 1024).
 * Non-finite and negative values are treated as 0.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }
  const n = Math.max(0, Math.floor(bytes));
  if (n === 0) {
    return '0 B';
  }
  const unitIndex = Math.min(Math.floor(Math.log2(n) / 10), UNITS.length - 1);
  const value = n / Math.pow(1024, unitIndex);
  const rendered = unitIndex === 0 ? String(n) : value.toFixed(decimals);
  return `${rendered} ${UNITS[unitIndex]}`;
}