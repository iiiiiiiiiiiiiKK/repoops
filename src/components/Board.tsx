import { useState } from 'react';
import { BUCKET_META, BUCKET_ORDER, type Bucket, type NormalizedItem } from '../../shared/types';
import { daysSince } from '../../shared/board';
import { IconIssue, IconPull, IconClock, IconExternal } from './Icons';
import { labelStyle, relativeTime } from '../lib/format';

const BUCKET_COLOR: Record<Bucket, string> = {
  triage: 'var(--purple)',
  review: 'var(--blue)',
  author: 'var(--amber)',
  stalled: 'var(--red)',
  done: 'var(--accent)',
};

interface CardProps {
  item: NormalizedItem;
  selected: boolean;
  checked: boolean;
  onOpen: () => void;
  onToggle: (checked: boolean) => void;
  staleDays: number;
}

function ItemCard({ item, selected, checked, onOpen, onToggle, staleDays }: CardProps) {
  const [hover, setHover] = useState(false);
  const idle = daysSince(item.updatedAt);
  const stale = item.state === 'open' && idle > staleDays;

  return (
    <div
      className={`card${selected ? ' card--selected' : ''}${checked ? ' card--checked' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="button"
      tabIndex={0}
      aria-label={`${item.kind === 'pr' ? 'PR' : 'Issue'} #${item.number} ${item.title}`}
      data-testid="item-card"
      data-item-id={item.id}
    >
      <div className="card__top">
        <input
          className="card__check"
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`选择 #${item.number}`}
        />
        <span className="card__kind" style={{ color: item.kind === 'pr' ? 'var(--purple)' : 'var(--accent)' }}>
          {item.kind === 'pr' ? <IconPull size={11} /> : <IconIssue size={11} />}
          {item.kind === 'pr' ? 'PR' : 'Issue'}
        </span>
        <span className="card__num">#{item.number}</span>
        {item.isDraft && <span className="chip" style={{ fontSize: 9.5, padding: '0 4px' }}>Draft</span>}
      </div>

      <div className="card__title">{item.title}</div>

      {item.labels.length > 0 && (
        <div className="card__labels">
          {item.labels.slice(0, 3).map((label) => (
            <span key={label.name} className="label-pill" style={labelStyle(label.color)} title={label.name}>
              {label.name}
            </span>
          ))}
          {item.labels.length > 3 && <span className="label-pill" style={{ color: 'var(--text-faint)' }}>+{item.labels.length - 3}</span>}
        </div>
      )}

      <div className="card__foot">
        <span className="card__author">
          {/*
            Cards use a local initial instead of the GitHub avatar: a board with
            120+ cards would otherwise fire 120+ third-party image requests to
            avatars.githubusercontent.com on every page load (slow first paint,
            and it leaks every reader's IP to GitHub). The real avatar is shown
            once, in the detail panel.
          */}
          <span className="card__avatar" aria-hidden>
            {item.author.slice(0, 1).toUpperCase()}
          </span>
          {item.author}
        </span>
        <span className="card__spacer" />
        {item.commentsCount > 0 && <span title="评论数">💬 {item.commentsCount}</span>}
        <span className={stale ? 'card__stale' : ''} title={`最后更新：${relativeTime(item.updatedAt)}`}>
          <IconClock size={10} style={{ verticalAlign: '-1px' }} /> {relativeTime(item.updatedAt)}
        </span>
        {hover && (
          <a
            href={item.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="faint"
            aria-label="在 GitHub 打开"
            title="在 GitHub 打开"
          >
            <IconExternal size={11} />
          </a>
        )}
      </div>
    </div>
  );
}

interface BoardProps {
  buckets: Record<Bucket, NormalizedItem[]>;
  selectedId: string | null;
  checked: Set<string>;
  onOpen: (item: NormalizedItem) => void;
  onToggleCheck: (id: string, next: boolean) => void;
  staleDays: number;
  loading: boolean;
}

export function Board({ buckets, selectedId, checked, onOpen, onToggleCheck, staleDays, loading }: BoardProps) {
  return (
    <div className="board" role="region" aria-label="维护看板" data-testid="board">
      {BUCKET_ORDER.map((bucket) => {
        const items = buckets[bucket];
        return (
          <section className="column" key={bucket} aria-label={BUCKET_META[bucket].zh} data-testid={`column-${bucket}`}>
            <div className="column__head">
              <span className="column__dot" style={{ background: BUCKET_COLOR[bucket] }} />
              <span className="column__title">{BUCKET_META[bucket].zh}</span>
              <span className="column__count" title={BUCKET_META[bucket].en}>
                {items.length}
              </span>
            </div>
            <div className="column__body">
              {loading && items.length === 0 ? (
                <>
                  <div className="skeleton" />
                  <div className="skeleton" />
                  <div className="skeleton" />
                </>
              ) : items.length === 0 ? (
                <div className="column__empty">{BUCKET_META[bucket].hint}</div>
              ) : (
                items.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    checked={checked.has(item.id)}
                    onOpen={() => onOpen(item)}
                    onToggle={(next) => onToggleCheck(item.id, next)}
                    staleDays={staleDays}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
