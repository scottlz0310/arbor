import { useUiStore } from '../stores/uiStore';
import { useReportStore } from '../stores/reportStore';
import { dailyRefresh, dsxDoctor, dsxSelfUpdate, repoUpdate, sysUpdate, sysUpdateDryRun, takeRunReport } from './invoke';
import { toastSuffix } from './runReport';
import type { DsxOutput, DsxStatus, RunReport, WorkspaceStatus } from '../types';

/**
 * 直近の実行の報告（警告・スキップ・失敗の内訳。dsx v0.13.0 以上）を取り出し、あれば保持する。
 * 失敗した実行にも報告があるので、成功・失敗のどちらの後にも呼ぶ。取得に失敗しても、実行の結果は変えない。
 */
async function collectReport(): Promise<RunReport | null> {
  try {
    const report = await takeRunReport();
    if (!report) return null;
    useReportStore.getState().setReport(report);
    return report;
  } catch (e) {
    useUiStore.getState().addToast(`実行結果の詳細を取得できませんでした: ${String(e)}`, 'error');
    return null;
  }
}

/** dsx の実行を始め、終了を Toast で知らせる。出力は実行ログコンソールに流れる。成功したかを返す。 */
async function runAction(label: string, action: () => Promise<DsxOutput>): Promise<boolean> {
  const { addToast } = useUiStore.getState();
  try {
    await action();
    const report = await collectReport();
    addToast(`${label} 完了${toastSuffix(report)}`, 'success');
    return true;
  } catch (e) {
    await collectReport();
    addToast(`${label}: ${String(e)}`, 'error');
    return false;
  }
}

export const runDailyRefresh = () => runAction('Daily Refresh', dailyRefresh);
export const runSysUpdate = () => runAction('sys update', sysUpdate);
export const runSysUpdateDryRun = () => runAction('sys update -n', sysUpdateDryRun);
export const runDoctor = () => runAction('dsx doctor', dsxDoctor);
export const runSelfUpdate = () => runAction('dsx self-update', dsxSelfUpdate);
export const runRepoUpdate = () => runAction('Update All', repoUpdate);

/** `dsx --version` の出力（例: `dsx version 0.10.2`）から、表示用の版（`v0.10.2`）を取り出す。 */
export function shortVersion(raw: string | null): string | null {
  if (!raw) return null;
  const version = raw.split(/\s+/).pop() ?? raw;
  return version.startsWith('v') ? version : `v${version}`;
}

/** Daily Refresh を実行できない理由。実行できるなら null。 */
export function dailyRefreshBlockReason(
  dsx: DsxStatus | null,
  workspace: WorkspaceStatus | null,
): string | null {
  if (!dsx || !workspace) return '状態を確認しています';
  if (!dsx.available) return 'dsx が見つかりません';
  if (!dsx.supports_daily_refresh) {
    return `Daily Refresh には dsx v0.12.0 以上が必要です（現在 ${shortVersion(dsx.version) ?? '不明'}）。dsx Tools タブから self-update を実行してください`;
  }
  if (workspace.root === null) return 'workspace root が未設定です。Settings で設定してください';
  if (workspace.root_error !== null) return workspace.root_error;
  return null;
}
