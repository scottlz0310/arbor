/**
 * 端末向け出力に含まれる ANSI エスケープシーケンスの最小限のパーサ。
 *
 * 色（前景 16 色）・太字・薄字だけを解釈し、それ以外のエスケープ（カーソル移動・OSC など）は取り除く。
 * 出力は構造化した断片で返し、HTML 文字列は作らない（React の要素として描画して XSS を避ける）。
 * 行ごとに独立して解釈する（前の行から色を引き継がない）。
 */

export interface AnsiStyle {
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const ESC = '\u001b';

// CSI（ESC [ …）・OSC（ESC ] … BEL / ST）・その他の 2 文字シーケンス。
const ESCAPE_PATTERN = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\^_])?/g;

const FOREGROUND: Record<number, string> = {
  30: 'var(--text3)',
  31: 'var(--red)',
  32: 'var(--green)',
  33: 'var(--amber)',
  34: 'var(--indigo)',
  35: 'var(--purple)',
  36: '#22d3ee',
  37: 'var(--text1)',
  90: 'var(--text2)',
  91: '#fca5a5',
  92: '#86efac',
  93: '#fde68a',
  94: 'var(--indigo-l)',
  95: '#d8b4fe',
  96: '#67e8f9',
  97: '#ffffff',
};

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = (params === '' ? ['0'] : params.split(/[;:]/)).map((p) => (p === '' ? 0 : Number(p)));
  let next = { ...style };

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 39) next.color = undefined;
    else if (code in FOREGROUND) next.color = FOREGROUND[code];
    else if (code === 38 || code === 48) {
      // 256 色 / True Color は色を解釈せず、後続のパラメータだけ読み飛ばす。
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
  return next;
}

export function parseAnsi(text: string): AnsiSegment[] {
  if (!text.includes(ESC)) return [{ text, style: {} }];

  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let cursor = 0;

  for (const match of text.matchAll(ESCAPE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), style });
    cursor = start + match[0].length;
    if (match[2] === 'm') style = applySgr(style, match[1] ?? '');
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), style });

  return segments;
}

export function stripAnsi(text: string): string {
  return text.includes(ESC) ? text.replace(ESCAPE_PATTERN, '') : text;
}
