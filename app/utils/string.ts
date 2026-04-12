export function truncate(s: string, n: number): string {
  if (n <= 0) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
