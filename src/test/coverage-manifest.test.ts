import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';

// bun test のカバレッジはテスト実行中に読み込まれたファイルしか LCOV に含めない
// （vitest の coverage.include と異なり、未実行ファイルが母集団から脱落する）。
// カバレッジ対象ディレクトリの全ソースを glob で列挙して import することで、
// テストのないファイルも 0% 近傍の実績として LCOV に含め、母集団を固定する。
// ファイル集合はハードコードせず走査で決めるため、新規ファイルも自動で対象になる。
const COVERAGE_TARGET_GLOB = '{lib,components,views}/**/*.{ts,tsx}';

describe('coverage manifest', () => {
  it('カバレッジ対象の全ソースファイルを読み込む', async () => {
    const glob = new Glob(COVERAGE_TARGET_GLOB);
    const files = (await Array.fromAsync(glob.scan({ cwd: `${import.meta.dir}/..` })))
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => !/\.test\.(ts|tsx)$/.test(f))
      .sort();

    // 走査自体の破綻（cwd ミス・glob typo で 0 件になる等）を検出する
    expect(files.length).toBeGreaterThanOrEqual(17);

    for (const file of files) {
      const mod = await import(`../${file}`);
      expect(mod).toBeDefined();
    }
  });
});
