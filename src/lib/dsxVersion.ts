// "v0.11.0" や "dsx version 0.11.0" から、X.Y.Z を取り出す。解析できない場合は null を返す。
function parseSemverLike(value: string): [number, number, number] | null {
  const m = value.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a >= b なら 0 以上、a < b なら負数、比較不能なら null を返す。 */
export function compareSemverLike(a: string, b: string): number | null {
  const av = parseSemverLike(a);
  const bv = parseSemverLike(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}
