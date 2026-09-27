/** True if version a is newer than b (dotted numbers, e.g. 2.10.0 > 2.9.1; a leading "v" is ignored). */
export function isNewerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/i, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
