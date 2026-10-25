import { IconClock, IconMenu, IconMoon, IconRefresh, IconSearch, IconSun, IconWarn, IconX, IconChart, IconExternal } from './Icons';
import { dateTime, relativeTime } from '../lib/format';
import type { SessionInfo, TrackerRepo } from '../../shared/types';
import { AUTHOR_X_HANDLE, AUTHOR_X_URL } from './Sidebar';

interface Props {
  session: SessionInfo | null;
  repo: TrackerRepo | null;
  mode: 'live' | 'demo';
  query: string;
  onQuery: (value: string) => void;
  onSync: () => void;
  syncing: boolean;
  onMenu: () => void;
  onTheme: () => void;
  theme: 'dark' | 'light';
  onReport: () => void;
  reportEnabled: boolean;
  onSettings: () => void;
  staleNotice: boolean;
}

export function TopBar({
  session,
  repo,
  mode,
  query,
  onQuery,
  onSync,
  syncing,
  onMenu,
  onTheme,
  theme,
  onReport,
  reportEnabled,
  onSettings,
  staleNotice,
}: Props) {
  const rate = repo?.sync.rateLimit;
  const lowQuota = rate ? rate.remaining <= Math.max(5, rate.limit * 0.1) : false;

  // Roll every sync warning into one compact pill so the phone header can show
  // it without a clipped text chip. The detail stays in 设置 → 同步状态.
  const warnParts: string[] = [];
  if (!repo?.sync.complete && (repo?.sync.pagesFetched ?? 0) > 0) warnParts.push('分页未完（达到 6 页上限）');
  if ((repo?.sync.errors.length ?? 0) > 0) warnParts.push(`${repo?.sync.errors.length} 个同步错误`);
  if (staleNotice) warnParts.push('GitHub 不可达，正在显示缓存');
  if (lowQuota) warnParts.push(`API 配额偏低（剩 ${rate?.remaining}）`);
  const warnCount = warnParts.length;
  const warnText = warnParts.join('\n');

  return (
    <header className="topbar">
      <button className="btn btn--ghost btn--icon topbar__menu mobile-only" onClick={onMenu} aria-label="打开仓库导航">
        <IconMenu />
      </button>

      <div className="topbar__title">
        <span className="topbar__repo" title={repo ? repo.fullName : 'RepoOps'}>
          {repo ? repo.fullName : 'RepoOps'}
        </span>
        <span className="topbar__sub">
          {mode === 'demo' ? (
            <span className="chip chip--demo" title="演示快照：来自公开 GitHub API，只读，不属于任何登录用户">
              演示数据
            </span>
          ) : (
            <span className="chip chip--live">已连接</span>
          )}
          {/* Compact warning pill for phones: text chips would be clipped at
              320px, so narrow screens get one icon that opens 设置 → 同步状态. */}
          {warnCount > 0 && (
            <button
              className="chip chip--warn topbar__warn"
              onClick={onSettings}
              aria-label={`有 ${warnCount} 项同步提醒，查看设置`}
              title={warnText}
            >
              <IconWarn size={11} />
              {warnCount}
            </button>
          )}
          {repo ? (
            <>
              {/* Secondary metadata: hidden on narrow phones so the header keeps
                  a single line. The full picture lives in 设置 → 同步状态. */}
              <span className="topbar__opt" title="上次同步时间">
                <IconClock size={11} style={{ verticalAlign: '-1px' }} /> {repo.sync.lastSyncAt ? relativeTime(repo.sync.lastSyncAt) : '尚未同步'}
              </span>
              <span className="topbar__opt faint">·</span>
              <span className="topbar__opt">{repo.sync.itemCount} 项</span>
              {rate && (
                <>
                  <span className="topbar__opt faint">·</span>
                  <span
                    className={`topbar__opt${lowQuota ? ' chip chip--warn' : ''}`}
                    title={`GitHub API 配额，${dateTime(rate.resetAt)} 重置`}
                  >
                    API {rate.remaining}/{rate.limit}
                  </span>
                </>
              )}
              {!repo.sync.complete && repo.sync.pagesFetched > 0 && (
                <>
                  <span className="topbar__opt faint">·</span>
                  <span className="chip chip--warn" title="已达到分页上限，仓库还有更多数据未拉取">
                    分页未完
                  </span>
                </>
              )}
              {repo.sync.errors.length > 0 && (
                <>
                  <span className="topbar__opt faint">·</span>
                  <span className="chip chip--error" title={repo.sync.errors.map((e) => e.message).join('\n')}>
                    <IconWarn size={10} /> {repo.sync.errors.length} 个同步错误
                  </span>
                </>
              )}
              {staleNotice && (
                <>
                  <span className="topbar__opt faint">·</span>
                  <span className="chip chip--warn">GitHub 不可达，显示缓存</span>
                </>
              )}
            </>
          ) : (
            <span>只读维护工作台</span>
          )}
        </span>
      </div>

      {/* Second header row on phones (search + tool icons). On desktop this
          wrapper is `display: contents`, so its children flow into the single
          desktop row exactly as before. */}
      <div className="topbar__row2">
        <div className="search">
          <span className="search__icon">
            <IconSearch />
          </span>
          <input
            id="repoops-search"
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜索标题、编号、作者、标签…"
            aria-label="搜索 Issue 和 PR"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button className="search__clear" onClick={() => onQuery('')} aria-label="清除搜索">
              <IconX size={12} />
            </button>
          ) : (
            <kbd className="search__kbd">/</kbd>
          )}
        </div>

        <div className="topbar__actions topbar__actions--tools">
          <button
            className="btn btn--sm topbar__action"
            onClick={onSync}
            disabled={syncing || mode === 'demo' || !session?.authenticated}
            title={
              mode === 'demo'
                ? '演示快照每 6 小时由定时任务刷新；GitHub 不可达时回退到上一份可用快照'
                : '重新同步该仓库'
            }
            aria-label={syncing ? '同步中' : '同步'}
          >
            <IconRefresh size={13} style={syncing ? { animation: 'spin 0.9s linear infinite' } : undefined} />
            <span className="hide-xs">{syncing ? '同步中' : '同步'}</span>
          </button>
          <button
            className="btn btn--sm topbar__action"
            onClick={onReport}
            disabled={!reportEnabled}
            title="生成维护周报"
            aria-label="维护周报"
          >
            <IconChart size={13} />
            <span className="hide-xs">周报</span>
          </button>
          <button
            className="btn btn--ghost btn--icon"
            onClick={onTheme}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </div>

      <div className="topbar__actions topbar__actions--main">
        <button className="btn btn--ghost btn--icon" onClick={onSettings} aria-label="设置与连接">
          <IconExternal size={13} />
        </button>
        {/* Author X link — pinned to the top-right corner on every breakpoint. */}
        <a
          className="btn btn--ghost btn--icon"
          href={AUTHOR_X_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`作者 X 主页 ${AUTHOR_X_HANDLE}`}
          title={`作者 𝕏 ${AUTHOR_X_HANDLE}`}
          style={{ color: 'var(--text)' }}
        >
          <span style={{ fontWeight: 700, fontSize: 15, lineHeight: 1 }}>𝕏</span>
        </a>
      </div>
    </header>
  );
}
