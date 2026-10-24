import type { BoardThresholds, NormalizedItem } from '../../shared/types';
import { bucketOf, draftChecklist, draftComment } from '../../shared/board';
import { BUCKET_META } from '../../shared/types';
import { IconCheck, IconCopy, IconX } from './Icons';
import { copyToClipboard } from '../lib/format';
import { useState } from 'react';

interface Props {
  items: NormalizedItem[];
  thresholds: BoardThresholds;
  onClear: () => void;
  onToast: (kind: 'ok' | 'error' | 'info', message: string) => void;
}

/**
 * Batch action bar: copies drafts for the selected items.
 * There is intentionally no "post comment" or "close issue" action — those
 * would write to GitHub and are out of scope by design.
 */
export function BatchBar({ items, thresholds, onClear, onToast }: Props) {
  const [which, setWhich] = useState<'comments' | 'checklist'>('comments');

  if (items.length === 0) return null;

  const build = () => {
    if (which === 'checklist') {
      return items.map((item) => draftChecklist(item)).join('\n\n---\n\n');
    }
    return items
      .map((item) => {
        const bucket = BUCKET_META[bucketOf(item, thresholds)].zh;
        return `### ${item.repo}#${item.number} · ${bucket}\n${item.htmlUrl}\n\n${draftComment(item, thresholds)}`;
      })
      .join('\n\n---\n\n');
  };

  const copy = async () => {
    const ok = await copyToClipboard(build());
    onToast(ok ? 'ok' : 'error', ok ? `已复制 ${items.length} 个事项的${which === 'comments' ? '评论草稿' : '任务清单'}` : '复制失败');
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 14px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        flex: 'none',
      }}
      role="region"
      aria-label="批量操作"
      data-testid="batch-bar"
    >
      <span className="chip chip--live">{items.length} 项已选</span>
      <select className="select" value={which} onChange={(e) => setWhich(e.target.value as 'comments' | 'checklist')}>
        <option value="comments">评论草稿</option>
        <option value="checklist">任务清单</option>
      </select>
      <button className="btn btn--primary btn--sm" onClick={copy}>
        <IconCopy size={12} />
        批量复制
      </button>
      <a
        className="btn btn--sm"
        href={items[0].htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="在 GitHub 打开第一项"
      >
        <IconCheck size={12} />
        打开首项
      </a>
      <button className="btn btn--ghost btn--sm" onClick={onClear} style={{ marginLeft: 'auto' }}>
        <IconX size={12} />
        取消选择
      </button>
      <span className="faint" style={{ fontSize: 10.5, flexBasis: '100%' }}>
        只复制文本，不写入 GitHub。发布前请自行确认。
      </span>
    </div>
  );
}
