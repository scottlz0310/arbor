import { describe, expect, it } from 'bun:test';
import { parseAnsi, stripAnsi } from './ansi';

const E = '\u001b';
// ST（ESC \）の後半。テンプレートリテラルに直接書くと `\b` などの別のエスケープになる。
const BACKSLASH = String.fromCharCode(92);

describe('parseAnsi', () => {
  it('エスケープを含まない文字列は 1 つの断片で返す', () => {
    expect(parseAnsi('plain text')).toEqual([{ text: 'plain text', style: {} }]);
  });

  it.each([
    { name: '赤', input: `${E}[31mred${E}[0m`, color: 'var(--red)' },
    { name: '緑', input: `${E}[32mok${E}[0m`, color: 'var(--green)' },
    { name: '黄', input: `${E}[33mwarn${E}[0m`, color: 'var(--amber)' },
    { name: '明るい赤', input: `${E}[91mbright${E}[0m`, color: '#fca5a5' },
    { name: 'コロン区切り', input: `${E}[31:1mred${E}[0m`, color: 'var(--red)' },
  ])('前景色（$name）を解釈する', ({ input, color }) => {
    const [segment] = parseAnsi(input);
    expect(segment.style.color).toBe(color);
  });

  it('太字・薄字を解釈し、22 で解除する', () => {
    const segments = parseAnsi(`${E}[1mbold${E}[2mdim${E}[22mnone`);
    expect(segments.map((s) => [s.text, s.style.bold, s.style.dim])).toEqual([
      ['bold', true, undefined],
      ['dim', true, true],
      ['none', false, false],
    ]);
  });

  it('リセット（0 と引数なし）で装飾を解除する', () => {
    const segments = parseAnsi(`${E}[31mred${E}[mplain${E}[32mgreen${E}[0mend`);
    expect(segments.map((s) => [s.text, s.style.color])).toEqual([
      ['red', 'var(--red)'],
      ['plain', undefined],
      ['green', 'var(--green)'],
      ['end', undefined],
    ]);
  });

  it('39 で前景色だけを戻す', () => {
    const segments = parseAnsi(`${E}[1;31mx${E}[39my`);
    expect(segments[1].style).toEqual({ bold: true, color: undefined });
  });

  it.each([
    { name: '256 色', input: `${E}[38;5;208mtext` },
    { name: 'True Color', input: `${E}[38;2;10;20;30mtext` },
    { name: '背景色', input: `${E}[41mtext` },
  ])('$name は色を解釈せず、後続のパラメータを正しく読み飛ばす', ({ input }) => {
    const segments = parseAnsi(input);
    expect(segments).toEqual([{ text: 'text', style: {} }]);
  });

  it('色指定の直後のパラメータ（太字）は読み飛ばさない', () => {
    const [segment] = parseAnsi(`${E}[38;5;208;1mtext`);
    expect(segment.style.bold).toBe(true);
  });

  it.each([
    { name: 'カーソル移動', input: `a${E}[2Kb${E}[1Ac` },
    { name: 'OSC（BEL 終端）', input: `a${E}]0;title\u0007bc` },
    { name: 'OSC（ST 終端）', input: `a${E}]8;;http://x${E}${BACKSLASH}bc` },
    { name: '単独の ESC', input: `a${E}bc` },
  ])('$name は取り除く', ({ input }) => {
    expect(parseAnsi(input).map((s) => s.text).join('')).toBe('abc');
  });

  it('HTML の特殊文字はそのまま文字列として返す（要素にしない）', () => {
    const [segment] = parseAnsi(`${E}[31m<script>alert(1)</script>${E}[0m`);
    expect(segment.text).toBe('<script>alert(1)</script>');
  });
});

describe('stripAnsi', () => {
  it.each([
    { name: '色付き', input: `${E}[31mred${E}[0m text`, expected: 'red text' },
    { name: 'エスケープなし', input: 'plain', expected: 'plain' },
    { name: '空文字', input: '', expected: '' },
  ])('$name', ({ input, expected }) => {
    expect(stripAnsi(input)).toBe(expected);
  });
});
