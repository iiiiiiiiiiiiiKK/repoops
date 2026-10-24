import { useMemo, useState } from 'react';
import type { BoardThresholds, NormalizedItem, WeeklyReport } from '../../shared/types';
import { buildWeeklyReport, reportToMarkdown } from '../../shared/board';
import { IconCheck, IconCopy, IconX } from './Icons';
import { copyToClipboard, downloadText, shortDate } from '../lib/format';

interface Props {
  repoFullName: string;
  items: NormalizedItem[];
  thresholds: BoardThresholds;
  /** Server-generated report, when the user is signed in. */
  serverReport: WeeklyReport | null;
  reportError: string | null;
  loading: boolean;
  onClose: () => void;
  onCopy: (kind: 'ok' | 'error', message: string) => void;
}

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <span className="faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="mono" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function ReportModal({
  repoFullName,
  items,
  thresholds,
  serverReport,
  reportError,
  loading,
  onClose,
  onCopy,
}: Props) {
  /**
   * The report shown is the server-generated one when available (signed-in flow,
   * numbers come from the same cached rows the board used), otherwise it is
   * computed locally from the exact same pure function — so the numbers can
   * never diverge between modes.
   */
  const report = useMemo(() => {
    if (serverReport && serverReport.repo === repoFullName) return serverReport;
    if (!repoFullName || items.length === 0) return null;
    return buildWeeklyReport(repoFullName, items, thresholds);
  }, [serverReport, repoFullName, items, thresholds]);

  const [copied, setCopied] = useState(false);
  const markdown = report ? reportToMarkdown(report) : '';
  const maxBucket = report ? Math.max(1, ...Object.values(report.buckets)) : 1;

  const handleCopy = async () => {
    const ok = await copyToClipboard(markdown);
    if (ok) {
      setCopied(true);
      onCopy('ok', '周报 Markdown 已复制');
      setTimeout(() => setCopied(false), 2200);
    } else {
      onCopy('error', '复制失败，请手动选择文本');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="维护周报"
        onClick={(e) => e.stopPropagation()}
        data-testid="report-modal"
      >
        <div className="modal__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 className="modal__title">{repoFullName} 维护周报</h3>
            <div className="modal__sub">
              窗口 {report ? `${shortDate(report.windowFrom)} → ${shortDate(report.windowTo)}` : '—'} · 停滞阈值{' '}
              {thresholds.staleDays} 天 · 数字与实际缓存数据一致
            </div>
          </div>
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="关闭">
            <IconX size={14} />
          </button>
        </div>

        <div className="modal__body">
          {loading && <div className="row"><span className="spinner" /> <span className="dim">正在生成服务端周报…</span></div>}
          {reportError && (
            <div className="notice notice--warn" style={{ marginBottom: 12 }}>
              <span>服务端周报不可用（{reportError}），以下数字由浏览器基于同一份缓存数据本地计算。</span>
            </div>
          )}

          {!report ? (
            <div className="faint">暂无可统计的数据。</div>
          ) : (
            <>
              <div className="stat-grid">
                <div className="stat">
                  <div className="stat__label">健康度</div>
                  <div className="stat__value" style={{ color: report.healthScore >= 70 ? 'var(--accent)' : report.healthScore >= 40 ? 'var(--amber)' : 'var(--red)' }}>
                    {report.healthScore}
                    <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>/100</span>
                  </div>
                  <div className="stat__hint">越低说明积压越严重</div>
                </div>
                <div className="stat">
                  <div className="stat__label">开启事项</div>
                  <div className="stat__value">{report.totals.open}</div>
                  <div className="stat__hint">Issue {report.totals.issues} · PR {report.totals.prs}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">等待审查</div>
                  <div className="stat__value" style={{ color: 'var(--blue)' }}>{report.totals.awaitingReview}</div>
                  <div className="stat__hint">需要维护者动作</div>
                </div>
                <div className="stat">
                  <div className="stat__label">已停滞</div>
                  <div className="stat__value" style={{ color: 'var(--red)' }}>{report.totals.stalled}</div>
                  <div className="stat__hint">&gt; {thresholds.staleDays} 天无更新</div>
                </div>
                <div className="stat">
                  <div className="stat__label">窗口内新开</div>
                  <div className="stat__value">{report.totals.openedInWindow}</div>
                  <div className="stat__hint">过去 {thresholds.doneDays} 天</div>
                </div>
                <div className="stat">
                  <div className="stat__label">窗口内完成</div>
                  <div className="stat__value" style={{ color: 'var(--accent)' }}>{report.totals.closedInWindow}</div>
                  <div className="stat__hint">合并 {report.totals.mergedInWindow}</div>
                </div>
              </div>

              <div className="field">
                <span className="field__label">队列分布</span>
                <Bar label="待处理" value={report.buckets.triage} max={maxBucket} color="var(--purple)" />
                <Bar label="等待审查" value={report.buckets.review} max={maxBucket} color="var(--blue)" />
                <Bar label="等待作者" value={report.buckets.author} max={maxBucket} color="var(--amber)" />
                <Bar label="已停滞" value={report.buckets.stalled} max={maxBucket} color="var(--red)" />
                <Bar label="近期完成" value={report.buckets.done} max={maxBucket} color="var(--accent)" />
              </div>

              {report.topLabels.length > 0 && (
                <div className="field">
                  <span className="field__label">热点标签</span>
                  <div className="row">
                    {report.topLabels.map((l) => (
                      <span key={l.name} className="chip">
                        {l.name} · {l.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {report.busiestAuthors.length > 0 && (
                <div className="field">
                  <span className="field__label">提交最多的作者</span>
                  <div className="row">
                    {report.busiestAuthors.map((a) => (
                      <span key={a.login} className="chip">
                        @{a.login} · {a.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {report.oldestStalled.length > 0 && (
                <div className="field">
                  <span className="field__label">最久未动</span>
                  <div className="stack">
                    {report.oldestStalled.map((row) => (
                      <a
                        key={row.id}
                        href={row.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="row"
                        style={{ justifyContent: 'space-between', fontSize: 12, gap: 10 }}
                      >
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          #{row.number} {row.title}
                        </span>
                        <span className="chip chip--warn" style={{ flex: 'none' }}>{row.days} 天</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="field">
                <span className="field__label">本周建议</span>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.75, color: 'var(--text-dim)' }}>
                  {report.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>

              <div className="field">
                <span className="field__label">Markdown 预览</span>
                <pre className="md-box" data-testid="report-markdown">{markdown}</pre>
              </div>
            </>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose} data-testid="report-close">
            关闭
          </button>
          <button
            className="btn"
            onClick={() => downloadText(`${repoFullName.replace('/', '-')}-weekly.md`, markdown)}
            disabled={!report}
          >
            下载 .md
          </button>
          <button className="btn btn--primary" onClick={handleCopy} disabled={!report}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            {copied ? '已复制' : '复制 Markdown'}
          </button>
        </div>
      </div>
    </div>
  );
}
