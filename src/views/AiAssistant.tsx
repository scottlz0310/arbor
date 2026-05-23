import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import { getAiInsights, getConfig, ollamaAvailable } from '../lib/invoke';
import { convertAiInsights, fetchInsights, type InsightSource } from '../lib/aiService';
import type { AiConfig, AiInsight, Insight } from '../types';

type ConnectionState = 'unknown' | 'checking' | 'connected' | 'disconnected';

const INSIGHT_STYLE: Record<Insight['type'], { bg: string; border: string; icon: string; color: string; label: string }> = {
  risk:       { bg: 'var(--red-bg)',    border: '#f8717128', icon: '⚠', color: 'var(--red)',     label: 'Risk' },
  prioritize: { bg: 'var(--amber-bg)',  border: '#fbbf2428', icon: '↑', color: 'var(--amber)',   label: 'Prioritize' },
  explain:    { bg: 'var(--indigo-bg)', border: '#818cf828', icon: '●', color: 'var(--indigo-l)', label: 'Explain' },
};

const PRIORITY_COLOR: Record<Insight['priority'], string> = {
  high:   'var(--red)',
  medium: 'var(--amber)',
  low:    'var(--text3)',
};

export default function AiAssistant() {
  const { repos, selectedRepo } = useRepoStore();
  const { addToast, navigate } = useUiStore();

  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('unknown');

  const [insights, setInsights]         = useState<Insight[]>([]);
  const [source, setSource]             = useState<InsightSource>('rule');
  const [insightLoading, setInsightLoading] = useState(false);
  const [aiBgRunning, setAiBgRunning]   = useState(false);
  const [aiFailed, setAiFailed]         = useState(false);
  const [ollamaOffline, setOllamaOffline] = useState(false);
  const [reanalyzing, setReanalyzing]   = useState(false);

  // 接続テスト：Settings の testAiConnection はフォーム入力中の URL を検証するためのもの。
  // ここでは保存済み config を使って稼働確認したいので ollamaAvailable を使う。
  // ボタン経由の明示的トリガなので cancelled guard は不要（初回 mount 時は useEffect 側で wrap）。
  const checkConnection = () => {
    setConnection('checking');
    ollamaAvailable()
      .then((ok) => setConnection(ok ? 'connected' : 'disconnected'))
      .catch(() => setConnection('disconnected'));
  };

  // 初回ロード：AI config と接続状態を取得
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((cfg) => { if (!cancelled) setAiConfig(cfg.ai); })
      .catch(() => {});
    setConnection('checking');
    ollamaAvailable()
      .then((ok) => { if (!cancelled) setConnection(ok ? 'connected' : 'disconnected'); })
      .catch(() => { if (!cancelled) setConnection('disconnected'); });
    return () => { cancelled = true; };
  }, []);

  // Insight 取得（repos / aiConfig 変更時に再実行）
  // - aiConfig 未ロード時は待機
  // - AI 無効化時は取得自体を抑止し、UI 側で「Settings で有効化してください」を促す
  // - cancelled guard で repos 連続更新時の race を防ぐ
  // - mid-fetch 中に non-active 分岐へ遷移した場合に loading が残らないよう全分岐で明示リセット
  useEffect(() => {
    if (repos.length === 0) {
      setInsights([]);
      setOllamaOffline(false);
      setAiBgRunning(false);
      setAiFailed(false);
      setInsightLoading(false);
      return;
    }
    if (aiConfig === null) {
      setInsightLoading(false);
      return; // 初期ロード完了待ち
    }
    if (!aiConfig.enabled) {
      setInsights([]);
      setOllamaOffline(false);
      setAiBgRunning(false);
      setAiFailed(false);
      setInsightLoading(false);
      return;
    }
    let cancelled = false;
    setInsightLoading(true);
    setAiFailed(false);
    fetchInsights(repos, {}, 14)
      .then(({ insights: ins, source: s, ollamaOffline: offline }) => {
        if (cancelled) return;
        setInsights(ins);
        setSource(s);
        setOllamaOffline(offline);
      })
      .finally(() => { if (!cancelled) setInsightLoading(false); });
    return () => { cancelled = true; };
  }, [repos, aiConfig]);

  // バックグラウンド AI 更新イベント
  useEffect(() => {
    const unUpdated = listen<AiInsight[]>('ai_insights_updated', (ev) => {
      setInsights(convertAiInsights(ev.payload));
      setSource('ai');
      setAiBgRunning(false);
      setAiFailed(false);
    });
    const unLoading = listen<void>('ai_insights_loading', () => {
      setAiBgRunning(true);
      setAiFailed(false);
    });
    const unFailed = listen<void>('ai_insights_failed', () => {
      setAiBgRunning(false);
      setAiFailed(true);
    });
    return () => {
      unUpdated.then((f) => f());
      unLoading.then((f) => f());
      unFailed.then((f) => f());
    };
  }, []);

  // 再分析：キャッシュをバイパスして強制再生成（getAiInsightsCached ではなく getAiInsights を直接呼ぶ）
  const handleReanalyze = async () => {
    if (repos.length === 0) return;
    setReanalyzing(true);
    setAiFailed(false);
    try {
      const raw = await getAiInsights(repos);
      setInsights(convertAiInsights(raw));
      setSource('ai');
      setOllamaOffline(false);
      addToast('AI 再分析が完了しました', 'success');
    } catch (e) {
      setAiFailed(true);
      addToast(`AI 分析に失敗しました: ${String(e)}`, 'error');
    } finally {
      setReanalyzing(false);
    }
  };

  // リポジトリ別に Insight をグルーピング（path で識別 — 同名 repo を区別するため）
  const insightsByRepo = repos.reduce<Record<string, Insight[]>>((acc, r) => {
    acc[r.path] = insights.filter((i) => i.repo_path === r.path);
    return acc;
  }, {});
  const selectedInsights = selectedRepo ? insightsByRepo[selectedRepo.path] ?? [] : [];

  const aiEnabled = aiConfig?.enabled ?? false;
  const reanalyzeDisabled =
    reanalyzing || repos.length === 0 || connection !== 'connected' || !aiEnabled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={<span style={{ color: 'var(--text2)' }}>AI Assistant</span>}
        actions={
          <>
            <AppBtn onClick={checkConnection} disabled={connection === 'checking'}>
              {connection === 'checking' ? 'Testing…' : '接続テスト'}
            </AppBtn>
            <AppBtn
              variant="primary"
              onClick={handleReanalyze}
              disabled={reanalyzeDisabled}
              title={!aiEnabled ? 'AI Insight が無効です（Settings で有効化）' : undefined}
            >
              {reanalyzing ? '分析中…' : '⟳ 再分析'}
            </AppBtn>
          </>
        }
      />

      <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
        {/* 接続ステータス */}
        <ConnectionCard
          connection={connection}
          aiConfig={aiConfig}
          onOpenSettings={() => navigate('settings')}
        />

        {/* 選択中リポジトリ */}
        <section style={{ marginTop: 20 }}>
          <SectionHeader
            title={selectedRepo ? `AI INSIGHTS — ${selectedRepo.name}` : 'AI INSIGHTS'}
            source={source}
            loading={insightLoading}
            aiBgRunning={aiBgRunning}
            aiFailed={aiFailed}
            ollamaOffline={ollamaOffline}
          />
          {/* path 補助表示: 同名 repo を視覚的に区別する（識別自体は repo_path で行う） */}
          {selectedRepo && (
            <div style={{
              fontSize: 10, color: 'var(--text3)',
              fontFamily: 'var(--font-mono)', marginBottom: 8,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {selectedRepo.path}
            </div>
          )}
          {!selectedRepo ? (
            <EmptyState message="リポジトリを選択してください" />
          ) : !aiEnabled ? (
            <EmptyState message="AI Insight が無効化されています。Settings で有効化してください" tone="amber" />
          ) : insightLoading ? (
            <EmptyState message="分析中…" />
          ) : selectedInsights.length > 0 ? (
            selectedInsights.map((ins, i) => <InsightDetailCard key={i} insight={ins} />)
          ) : aiBgRunning ? (
            <EmptyState message="AI が分析中です…" />
          ) : (
            <EmptyState
              message={ollamaOffline
                ? 'Ollama が未起動のため AI 分析を実行できません'
                : '✓ このリポジトリに特筆すべき項目はありません'}
              tone={ollamaOffline ? 'amber' : 'green'}
            />
          )}
        </section>

        {/* 全リポジトリ */}
        <section style={{ marginTop: 24 }}>
          <SectionHeader title="ALL REPOSITORIES" />
          {repos.length === 0 ? (
            <EmptyState message="リポジトリが登録されていません" />
          ) : !aiEnabled ? (
            <EmptyState message="AI Insight が無効化されています。Settings で有効化してください" tone="amber" />
          ) : (
            repos.map((r) => (
              <RepoInsightGroup
                key={r.path}
                repoName={r.name}
                repoPath={r.path}
                insights={insightsByRepo[r.path] ?? []}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function ConnectionCard({
  connection,
  aiConfig,
  onOpenSettings,
}: {
  connection: ConnectionState;
  aiConfig: AiConfig | null;
  onOpenSettings: () => void;
}) {
  const provider = aiConfig?.provider ?? '—';
  const model    = aiConfig?.model ?? '—';
  const enabled  = aiConfig?.enabled ?? false;

  const statusInfo = (() => {
    if (!enabled) return { icon: '○', color: 'var(--text3)', text: 'AI Insight は無効化されています' };
    switch (connection) {
      case 'checking':     return { icon: '⟳', color: 'var(--text3)', text: '接続確認中…' };
      case 'connected':    return { icon: '✓', color: 'var(--green)', text: 'Ollama に接続済み' };
      case 'disconnected': return { icon: '✗', color: 'var(--red)',   text: 'Ollama に接続できません' };
      default:             return { icon: '·', color: 'var(--text3)', text: '未確認' };
    }
  })();

  return (
    <div style={{
      background: 'var(--bg3)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r2)',
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 14, color: statusInfo.color, width: 16, textAlign: 'center' }}>
          {statusInfo.icon}
        </span>
        <span style={{ fontSize: 12, color: statusInfo.color, fontWeight: 600, flex: 1 }}>
          {statusInfo.text}
        </span>
        <AppBtn onClick={onOpenSettings}>Settings</AppBtn>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginLeft: 26 }}>
        <KeyValue label="PROVIDER" value={provider} />
        <KeyValue label="MODEL"    value={model} mono />
      </div>
    </div>
  );
}

function KeyValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 600, letterSpacing: '.12em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--text1)',
        fontFamily: mono ? 'var(--font-mono)' : undefined,
      }}>
        {value}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  source,
  loading,
  aiBgRunning,
  aiFailed,
  ollamaOffline,
}: {
  title: string;
  source?: InsightSource;
  loading?: boolean;
  aiBgRunning?: boolean;
  aiFailed?: boolean;
  ollamaOffline?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span style={{
        fontSize: 10, fontWeight: 600, color: 'var(--text3)',
        letterSpacing: '.1em', flex: 1,
      }}>
        {title}
      </span>
      {loading && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--text3)', fontWeight: 600 }}>
          <span className="arbor-spin">⟳</span> Rules…
        </span>
      )}
      {!loading && aiBgRunning && (
        <span style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 9, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
          background: 'var(--indigo-bg2)', color: 'var(--indigo-l)',
        }}>
          <span className="arbor-pulse">✦</span> AI 分析中…
        </span>
      )}
      {!loading && !aiBgRunning && aiFailed && (
        <span style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
          background: 'var(--amber-bg)', color: 'var(--amber)',
        }}>
          ✗ AI 失敗
        </span>
      )}
      {!loading && !aiBgRunning && !aiFailed && ollamaOffline && (
        <span style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
          background: 'var(--amber-bg)', color: 'var(--amber)',
        }}>
          ⚠ Offline
        </span>
      )}
      {!loading && !aiBgRunning && !aiFailed && !ollamaOffline && source && (
        <span style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
          background: source === 'ai' ? 'var(--indigo-bg2)' : 'var(--bg3)',
          color:      source === 'ai' ? 'var(--indigo-l)'   : 'var(--text3)',
        }}>
          {source === 'ai' ? '✦ AI' : 'Rules'}
        </span>
      )}
    </div>
  );
}

function InsightDetailCard({ insight }: { insight: Insight }) {
  const s = INSIGHT_STYLE[insight.type];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '12px 14px', background: s.bg,
      border: `1px solid ${s.border}`, borderRadius: 'var(--r2)',
      marginBottom: 6,
    }}>
      <span style={{ color: s.color, fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>{s.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: s.color, letterSpacing: '.06em' }}>
            {s.label}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>·</span>
          <span style={{ fontSize: 11, color: 'var(--text1)', fontWeight: 600 }}>
            {insight.target}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 4,
            background: `${PRIORITY_COLOR[insight.priority]}18`,
            color: PRIORITY_COLOR[insight.priority],
            fontWeight: 600,
          }}>
            {insight.priority}
          </span>
          <span style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 4,
            background: insight.source === 'ai' ? 'var(--indigo-bg2)' : 'var(--bg3)',
            color:      insight.source === 'ai' ? 'var(--indigo-l)'   : 'var(--text3)',
            fontWeight: 600,
          }}>
            {insight.source === 'ai' ? '✦ AI' : 'Rules'}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6 }}>
          {insight.reason}
        </div>
      </div>
    </div>
  );
}

function RepoInsightGroup({ repoName, repoPath, insights }: {
  repoName: string;
  repoPath: string;
  insights: Insight[];
}) {
  return (
    <div style={{
      padding: '10px 14px',
      background: 'var(--bg3)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      marginBottom: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--indigo-l)' }}>
          {repoName}
        </span>
        <span style={{
          flex: 1, fontSize: 10, color: 'var(--text3)',
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>
          {repoPath}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
          {insights.length === 0 ? '— no insights' : `${insights.length} insight${insights.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div style={{ height: insights.length > 0 ? 6 : 0 }} />
      {insights.map((ins, i) => {
        const s = INSIGHT_STYLE[ins.type];
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '6px 0', borderTop: i > 0 ? '1px solid var(--border)' : undefined,
          }}>
            <span style={{ color: s.color, fontSize: 11, flexShrink: 0, width: 14, textAlign: 'center' }}>
              {s.icon}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text2)', lineHeight: 1.5, flex: 1 }}>
              {ins.reason}
            </span>
            <span style={{
              fontSize: 9, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
              background: `${PRIORITY_COLOR[ins.priority]}18`,
              color: PRIORITY_COLOR[ins.priority],
              fontWeight: 600,
            }}>
              {ins.priority}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ message, tone }: { message: string; tone?: 'green' | 'amber' }) {
  const color =
    tone === 'green' ? 'var(--green)' :
    tone === 'amber' ? 'var(--amber)' :
    'var(--text3)';
  return (
    <div style={{ fontSize: 11, color, padding: '8px 2px' }}>
      {message}
    </div>
  );
}
