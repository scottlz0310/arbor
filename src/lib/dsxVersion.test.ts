import { describe, expect, it } from 'bun:test';
import { compareSemverLike } from './dsxVersion';

describe('compareSemverLike', () => {
  it.each([
    { name: '同じ版', a: 'v0.11.0', b: 'v0.11.0', sign: 0 },
    { name: '表記が違っても同じ版', a: 'dsx version 0.11.0', b: 'v0.11.0', sign: 0 },
    { name: 'minor が新しい', a: 'v0.11.0', b: 'v0.10.2', sign: 1 },
    { name: 'patch が古い', a: 'v0.10.2', b: 'v0.10.3', sign: -1 },
    { name: '桁数が違っても数として比べる（0.2.10 > 0.2.9）', a: 'v0.2.10', b: 'v0.2.9', sign: 1 },
    { name: '桁数が違っても数として比べる（0.2.5 < 0.2.50）', a: 'v0.2.5', b: 'v0.2.50', sign: -1 },
    { name: 'major が新しい', a: 'v1.0.0', b: 'v0.99.99', sign: 1 },
  ])('$name', ({ a, b, sign }) => {
    expect(Math.sign(compareSemverLike(a, b) ?? NaN)).toBe(sign);
  });

  it.each([
    { name: '解析できない（a）', a: 'dev', b: 'v0.11.0' },
    { name: '解析できない（b）', a: 'v0.11.0', b: '' },
    { name: '桁が足りない', a: 'v0.11', b: 'v0.11.0' },
  ])('$name ときは null', ({ a, b }) => {
    expect(compareSemverLike(a, b)).toBeNull();
  });
});
