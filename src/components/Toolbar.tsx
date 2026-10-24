import type { FilterState, SortKey } from '../../shared/board';
import type { BoardThresholds, NormalizedItem } from '../../shared/types';
import { IconX } from './Icons';

interface Props {
  filters: FilterState;
  onFilters: (next: FilterState) => void;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  thresholds: BoardThresholds;
  onThresholds: (next: BoardThresholds) => void;
  items: NormalizedItem[];
  resultCount: number;
  totalCount: number;
  selectedCount: number;
  onClearSelection: () => void;
  onSelectAll: () => void;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'updated-desc', label: '最近更新' },
  { key: 'updated-asc', label: '最久未更新' },
  { key: 'created-desc', label: '最新创建' },
  { key: 'created-asc', label: '最早创建' },
  { key: 'comments-desc', label: '评论最多' },
  { key: 'number-asc', label: '编号升序' },
];

export function Toolbar({
  filters,
  onFilters,
  sort,
  onSort,
  thresholds,
  onThresholds,
  items,
  resultCount,
  totalCount,
  selectedCount,
  onClearSelection,
  onSelectAll,
}: Props) {
  const labelOptions = [...new Set(items.flatMap((i) => i.labels.map((l) => l.name)))].sort((a, b) => a.localeCompare(b));
  const assigneeOptions = [...new Set(items.flatMap((i) => i.assignees))].sort((a, b) => a.localeCompare(b));

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  const activeFilterCount =
    filters.labels.length +
    filters.assignees.length +
    filters.kinds.length +
    (filters.age !== 'any' ? 1 : 0) +
    (filters.showClosed ? 0 : 1);

  return (
    <div className="toolbar" role="toolbar" aria-label="筛选与排序">
      <div className="toolbar__group">
        <select className="select" value={sort} onChange={(e) => onSort(e.target.value as SortKey)} aria-label="排序方式">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group" role="group" aria-label="类型">
        {(['issue', 'pr'] as const).map((kind) => {
          const active = filters.kinds.includes(kind);
          return (
            <button
              key={kind}
              className={`chip chip--clickable${active ? ' chip--live' : ''}`}
              onClick={() => onFilters({ ...filters, kinds: toggleIn(filters.kinds, kind) as Array<'issue' | 'pr'> })}
              aria-pressed={active}
            >
              {kind === 'issue' ? 'Issue' : 'PR'}
            </button>
          );
        })}
        <button
          className={`chip chip--clickable${filters.age === 'stalled' ? ' chip--warn' : ''}`}
          onClick={() => onFilters({ ...filters, age: filters.age === 'stalled' ? 'any' : 'stalled' })}
          aria-pressed={filters.age === 'stalled'}
        >
          仅停滞
        </button>
        <button
          className={`chip chip--clickable${filters.age === 'fresh' ? ' chip--live' : ''}`}
          onClick={() => onFilters({ ...filters, age: filters.age === 'fresh' ? 'any' : 'fresh' })}
          aria-pressed={filters.age === 'fresh'}
        >
          近期活跃
        </button>
        <button
          className={`chip chip--clickable${filters.showClosed ? ' chip--live' : ''}`}
          onClick={() => onFilters({ ...filters, showClosed: !filters.showClosed })}
          aria-pressed={filters.showClosed}
          title="显示或隐藏已关闭/已合并事项"
        >
          含已完成
        </button>
      </div>

      {labelOptions.length > 0 && (
        <>
          <div className="toolbar__divider" />
          <div className="toolbar__group">
            <select
              className="select"
              value=""
              onChange={(e) => {
                if (e.target.value) onFilters({ ...filters, labels: toggleIn(filters.labels, e.target.value) });
              }}
              aria-label="按标签筛选"
            >
              <option value="">标签…</option>
              {labelOptions.map((label) => (
                <option key={label} value={label}>
                  {filters.labels.includes(label) ? '✓ ' : ''}
                  {label}
                </option>
              ))}
            </select>
            {filters.labels.map((label) => (
              <span key={label} className="chip chip--live">
                {label}
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ padding: 0, minHeight: 0, lineHeight: 1 }}
                  onClick={() => onFilters({ ...filters, labels: filters.labels.filter((l) => l !== label) })}
                  aria-label={`移除标签 ${label}`}
                >
                  <IconX size={9} />
                </button>
              </span>
            ))}
          </div>
        </>
      )}

      {assigneeOptions.length > 0 && (
        <>
          <div className="toolbar__divider" />
          <div className="toolbar__group">
            <select
              className="select"
              value=""
              onChange={(e) => {
                if (e.target.value) onFilters({ ...filters, assignees: toggleIn(filters.assignees, e.target.value) });
              }}
              aria-label="按负责人筛选"
            >
              <option value="">负责人…</option>
              {assigneeOptions.map((login) => (
                <option key={login} value={login}>
                  {filters.assignees.includes(login) ? '✓ ' : ''}
                  {login}
                </option>
              ))}
            </select>
            {filters.assignees.map((login) => (
              <span key={login} className="chip chip--live">
                @{login}
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ padding: 0, minHeight: 0, lineHeight: 1 }}
                  onClick={() => onFilters({ ...filters, assignees: filters.assignees.filter((a) => a !== login) })}
                  aria-label={`移除负责人 ${login}`}
                >
                  <IconX size={9} />
                </button>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="toolbar__divider" />

      <label className="threshold" title="超过该天数没有任何更新的开启事项标为「已停滞」">
        停滞阈值
        <input
          type="range"
          min={3}
          max={180}
          step={1}
          value={thresholds.staleDays}
          onChange={(e) => onThresholds({ ...thresholds, staleDays: Number(e.target.value) })}
          aria-label="停滞阈值（天）"
        />
        <span className="threshold__value">{thresholds.staleDays}天</span>
      </label>

      <label className="threshold" title="「近期完成」列包含最近多少天内关闭/合并的事项">
        完成窗口
        <input
          type="range"
          min={3}
          max={90}
          step={1}
          value={thresholds.doneDays}
          onChange={(e) => onThresholds({ ...thresholds, doneDays: Number(e.target.value) })}
          aria-label="近期完成窗口（天）"
        />
        <span className="threshold__value">{thresholds.doneDays}天</span>
      </label>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {selectedCount > 0 ? (
          <>
            <span className="chip chip--live">{selectedCount} 已选</span>
            <button className="btn btn--sm" onClick={onSelectAll} title="选择当前筛选结果中的全部事项">
              全选结果
            </button>
            <button className="btn btn--sm btn--ghost" onClick={onClearSelection}>
              取消
            </button>
          </>
        ) : (
          <span className="faint" style={{ fontSize: 11 }}>
            {resultCount} / {totalCount} 项
            {activeFilterCount > 0 ? ` · ${activeFilterCount} 个筛选` : ''}
          </span>
        )}
      </div>
    </div>
  );
}
