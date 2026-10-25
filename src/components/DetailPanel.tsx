import { useEffect, useState } from 'react';
import type { BoardThresholds, NormalizedItem } from '../../shared/types';
import { bucketOf, daysSince, draftChecklist, draftComment } from '../../shared/board';
import { BUCKET_META } from '../../shared/types';
import { IconCheck, IconCopy, IconExternal, IconIssue, IconPull, IconWarn, IconX } from './Icons';
import { copyToClipboard, dateTime, labelStyle, relativeTime, shortDate } from '../lib/format';

type Tab = 'overview' | 'draft' | 'checklist';

interface Props {
  item: NormalizedItem | null;
  thresholds: BoardThresholds;
  onClose: () => void;
  onToast: (kind: 'ok' | 'error' | 'info', message: string) => void;
}

export function DetailPanel({ item, thresholds, onClose, onToast }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [copied, setCopied] = useState<'comment' | 'checklist' | null>(null);

  useEffect(() => {
    setTab('overview');
    setCopied(null);
  }, [item?.id]);

  if (!item) return null;

  const bucket = bucketOf(item, thresholds);
  const idle = daysSince(item.updatedAt);
  const comment = draftComment(item, thresholds);
  const checklist = draftChecklist(item);

  const copy = async (kind: 'comment' | 'checklist', text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(kind);
      onToast('ok', kind === 'comment' ? '评论草稿已复制到剪贴板' : '任务清单已复制到剪贴板');
      setTimeout(() => setCopied(null), 2200);
    } else {
      onToast('error', '复制失败：浏览器拒绝了剪贴板访问，请手动选中文本复制');
    }
  };

  return (
    <aside className="detail" aria-label="事项详情" data-testid="detail-panel">
      {/*
        Close is a direct child of the panel, pinned to its corner. Keeping it
        inside the header flex row meant a wide chip/title row could paint over
        it (and swallow the click), because later siblings stack above earlier
        ones for positioned and non-positioned mixes.
      */}
      <button className="btn btn--ghost btn--icon detail__close" onClick={onClose} aria-label="关闭详情面板">
        <IconX size={13} />
      </button>

      <div className="detail__head">
        <div className="detail__top">
          <span className="detail__kind">
            {item.kind === 'pr' ? <IconPull size={13} /> : <IconIssue size={13} />}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ gap: 6, marginBottom: 5 }}>
              <span className="mono faint" style={{ fontSize: 11 }}>
                {item.repo} #{item.number}
              </span>
              <span className="chip">{BUCKET_META[bucket].zh}</span>
              {item.state === 'closed' && <span className="chip chip--live">已{item.mergedAt ? '合并' : '关闭'}</span>}
              {item.state === 'open' && idle > thresholds.staleDays && <span className="chip chip--warn">停滞 {idle} 天</span>}
            </div>
            <h2 className="detail__title">{item.title}</h2>
            <div className="detail__meta">
              <span>@{item.author}</span>
              <span>创建 {shortDate(item.createdAt)}</span>
              <span>更新 {relativeTime(item.updatedAt)}</span>
              <span>{item.commentsCount} 条评论</span>
            </div>
          </div>
        </div>

        <div className="detail__actions" style={{ marginTop: 10 }}>
          <a className="btn btn--sm" href={item.htmlUrl} target="_blank" rel="noopener noreferrer">
            <IconExternal size={12} />
            在 GitHub 打开
          </a>
          <button className="btn btn--sm" onClick={() => copy('comment', comment)}>
            {copied === 'comment' ? <IconCheck size={12} /> : <IconCopy size={12} />}
            {copied === 'comment' ? '已复制' : '复制评论草稿'}
          </button>
        </div>
      </div>

      <div className="detail__scroll">
        <div className="tabs" role="tablist">
          {(
            [
              ['overview', '概览'],
              ['draft', '评论草稿'],
              ['checklist', '任务清单'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`tab${tab === key ? ' tab--active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <>
            <div className="field">
              <span className="field__label">标签</span>
              <div className="row">
                {item.labels.length === 0 ? (
                  <span className="faint" style={{ fontSize: 12 }}>无标签 — 建议分诊</span>
                ) : (
                  item.labels.map((label) => (
                    <span key={label.name} className="label-pill" style={labelStyle(label.color)}>
                      {label.name}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className="field">
              <span className="field__label">负责人</span>
              <div className="field__value">
                {item.assignees.length ? item.assignees.map((a) => `@${a}`).join('、') : <span className="faint">未指派</span>}
              </div>
            </div>

            {item.kind === 'pr' && (
              <div className="field">
                <span className="field__label">审查状态</span>
                <div className="field__value">
                  {item.reviewDecision === 'APPROVED'
                    ? '已通过审查'
                    : item.reviewDecision === 'CHANGES_REQUESTED'
                      ? '需要修改（已有 change request）'
                      : item.reviewDecision === 'REVIEW_REQUIRED'
                        ? '必须审查后才能合并'
                        : item.requestedReviewers.length
                          ? `等待 ${item.requestedReviewers.length} 位审查者`
                          : '尚未分配审查者'}
                  {item.isDraft && ' · Draft'}
                </div>
              </div>
            )}

            <div className="field">
              <span className="field__label">时间线</span>
              <div className="field__value mono" style={{ fontSize: 11.5, lineHeight: 1.9 }}>
                创建 {dateTime(item.createdAt)}
                <br />
                更新 {dateTime(item.updatedAt)}（{idle} 天前）
                {item.closedAt && (
                  <>
                    <br />
                    关闭 {dateTime(item.closedAt)}
                  </>
                )}
                {item.mergedAt && (
                  <>
                    <br />
                    合并 {dateTime(item.mergedAt)}
                  </>
                )}
              </div>
            </div>

            <div className="field">
              <span className="field__label">正文（截断）</span>
              {item.body ? (
                <div className="body-text">{item.body}</div>
              ) : (
                <div className="faint" style={{ fontSize: 12 }}>作者没有填写正文。</div>
              )}
            </div>

            <div className="notice notice--warn">
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                RepoOps 是只读工作台：不会自动评论、关闭或合并任何事项。所有草稿都需要你手动复制后在 GitHub 上确认发布。
              </span>
            </div>
          </>
        )}

        {tab === 'draft' && (
          <>
            <div className="field">
              <span className="field__label">评论草稿（可直接复制）</span>
              <pre className="md-box" data-testid="comment-draft">{comment}</pre>
            </div>
            <div className="row">
              <button className="btn btn--primary btn--sm" onClick={() => copy('comment', comment)}>
                {copied === 'comment' ? <IconCheck size={12} /> : <IconCopy size={12} />}
                {copied === 'comment' ? '已复制' : '复制草稿'}
              </button>
              <a className="btn btn--sm" href={item.htmlUrl} target="_blank" rel="noopener noreferrer">
                <IconExternal size={12} />
                去 GitHub 发布
              </a>
            </div>
            <div className="notice" style={{ marginTop: 12 }}>
              <span>草稿由本地规则生成，基于当前状态（{BUCKET_META[bucket].zh}、停滞 {idle} 天）。发布前请自行校订语气与事实。</span>
            </div>
          </>
        )}

        {tab === 'checklist' && (
          <>
            <div className="field">
              <span className="field__label">处理清单</span>
              <pre className="md-box" data-testid="checklist-draft">{checklist}</pre>
            </div>
            <div className="row">
              <button className="btn btn--primary btn--sm" onClick={() => copy('checklist', checklist)}>
                {copied === 'checklist' ? <IconCheck size={12} /> : <IconCopy size={12} />}
                {copied === 'checklist' ? '已复制' : '复制清单'}
              </button>
            </div>
            <div className="notice" style={{ marginTop: 12 }}>
              <span>这段 markdown 可以直接贴进 PR 描述或 Issue 评论里当作 maintainer checklist。</span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
