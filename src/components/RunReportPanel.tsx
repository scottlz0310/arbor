import type { ReactNode } from 'react';
import { categoryLabel, codeLabel, countsLabel, issueTitle, reportTone } from '../lib/runReport';
import type { ReportTone } from '../lib/runReport';
import type { RunReport } from '../types';

const TONE_COLOR: Record<ReportTone, string> = {
  ok: 'var(--green)',
  attention: 'var(--amber)',
  error: 'var(--red)',
};

const TONE_LABEL: Record<ReportTone, string> = {
  ok: '問題なし',
  attention: '要確認',
  error: '失敗あり',
};

interface Props {
  report: RunReport;
  /** 報告を受け取った時刻（Unix ミリ秒）。 */
  receivedAt: number | null;
}

/** 直近の dsx の実行の、失敗・スキップ・警告の内訳。コンソールのログは置き換えず、判定として添える。 */
export default function RunReportPanel({ report, receivedAt }: Props) {
  const tone = reportTone(report);
  const counts = countsLabel(report);

  return (
    <div
      style={{
        background: 'var(--bg3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: TONE_COLOR[tone] }}>{TONE_LABEL[tone]}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>dsx {report.command}</span>
        <span style={{ fontSize: 11, color: 'var(--text2)' }}>
          {counts ?? '失敗・スキップ・警告はありません'}
          {` · 成功 ${report.jobs.success} · 更新 ${report.updated}`}
        </span>
        {receivedAt !== null && (
          <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 'auto' }}>
            {new Date(receivedAt).toLocaleTimeString('ja-JP')}
          </span>
        )}
      </div>

      {report.error && <div style={{ fontSize: 11, color: 'var(--red)' }}>終了: {report.error}</div>}

      {report.issues.length > 0 && (
        <Group title="失敗・スキップ">
          {report.issues.map((issue) => (
            <Row
              key={`${issue.phase}/${issue.kind}/${issue.name}`}
              color={issue.status === 'failed' ? 'var(--red)' : 'var(--amber)'}
              label={codeLabel(issue.code)}
              title={issueTitle(issue)}
              detail={issue.reason}
            />
          ))}
        </Group>
      )}

      {report.warning_items.length > 0 && (
        <Group title="警告">
          {report.warning_items.map((warning, index) => (
            <Row
              key={`${warning.phase}/${warning.category}/${warning.subject}/${index}`}
              color="var(--amber)"
              label={categoryLabel(warning.category)}
              title={warning.subject}
              detail={warning.message}
            />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.1em' }}>{title}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </ul>
    </div>
  );
}

function Row({ color, label, title, detail }: { color: string; label: string; title: string; detail: string }) {
  return (
    <li style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.6, alignItems: 'baseline' }}>
      <span style={{ color, flexShrink: 0, minWidth: 130 }}>{label}</span>
      {title && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text1)', flexShrink: 0 }}>{title}</span>}
      <span style={{ color: 'var(--text2)', wordBreak: 'break-word' }}>{detail}</span>
    </li>
  );
}
