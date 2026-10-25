import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiClientError } from './api';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { Board } from './components/Board';
import { DetailPanel } from './components/DetailPanel';
import { ReportModal } from './components/ReportModal';
import { SettingsModal } from './components/SettingsModal';
import { BatchBar } from './components/BatchBar';
import { IconPlus, IconWarn } from './components/Icons';
import {
  DEFAULT_THRESHOLDS,
  type BoardThresholds,
  type NormalizedItem,
  type SessionInfo,
  type TrackerRepo,
  type WeeklyReport,
} from '../shared/types';
import {
  EMPTY_FILTERS,
  boardItems,
  groupByBucket,
  matchesFilters,
  sortItems,
  type FilterState,
  type SortKey,
} from '../shared/board';
import { useTheme } from './lib/useTheme';
import { useToasts } from './lib/useToasts';

const LS_REPO = 'repoops.activeRepo';
const LS_THRESHOLDS = 'repoops.thresholds';

function readThresholds(): BoardThresholds {
  try {
    const raw = localStorage.getItem(LS_THRESHOLDS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BoardThresholds>;
      if (Number.isFinite(parsed.staleDays) && Number.isFinite(parsed.doneDays)) {
        return { staleDays: Number(parsed.staleDays), doneDays: Number(parsed.doneDays) };
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_THRESHOLDS;
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const { toasts, push, dismiss } = useToasts();

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [repos, setRepos] = useState<TrackerRepo[]>([]);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  const [items, setItems] = useState<NormalizedItem[]>([]);
  /*
    Mode is derived, never stored.
    It used to be a state initialised to 'demo' and only flipped to 'live' after
    a dashboard load — so a freshly connected account with zero tracked repos
    (nothing to load) kept showing the orange 演示数据 badge, a demo banner with
    an empty repo name, and the subtitle 只读维护工作台, right after a successful
    GitHub authorization. Deriving it removes that whole class of bug.
  */
  const mode: 'live' | 'demo' = session?.authenticated ? 'live' : 'demo';
  const [staleNotice, setStaleNotice] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>('updated-desc');
  const [thresholds, setThresholds] = useState<BoardThresholds>(readThresholds);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Inline "add your first repo" form shown right after connecting.
  const [firstRepoInput, setFirstRepoInput] = useState('');
  const [firstRepoBusy, setFirstRepoBusy] = useState(false);
  const [firstRepoError, setFirstRepoError] = useState<string | null>(null);

  const searchRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------------- bootstrap ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.session();
        if (cancelled) return;
        setSession(info);
        if (info.authenticated) {
          const { repos: list } = await api.repos();
          if (cancelled) return;
          setRepos(list);
          const stored = localStorage.getItem(LS_REPO);
          const pick = list.find((r) => r.fullName === stored) ?? list[0];
          setActiveRepoName(pick?.fullName ?? null);
        } else {
          setActiveRepoName(info.demoRepo);
        }
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Load the dashboard for the active repo (demo or live). */
  const loadDashboard = useCallback(
    async (repoName: string, authenticated: boolean) => {
      setLoading(true);
      setLoadError(null);
      try {
        if (authenticated) {
          const payload = await api.dashboard(repoName);
          setItems(payload.items);
          setStaleNotice(false);
          setRepos((prev) => prev.map((r) => (r.fullName === repoName ? { ...r, ...payload.repo } : r)));
        } else {
          const payload = await api.demo(repoName);
          setItems(payload.items);
          setStaleNotice(payload.stale);
          setRepos([payload.repo]);
        }
      } catch (err) {
        // 401 means the session died between session check and dashboard call.
        if (err instanceof ApiClientError && err.status === 401) {
          setSession((s) => (s ? { ...s, authenticated: false, login: null } : s));
        }
        setLoadError((err as Error).message);
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!session || !activeRepoName || bootstrapping) return;
    void loadDashboard(activeRepoName, session.authenticated);
    try {
      localStorage.setItem(LS_REPO, activeRepoName);
    } catch {
      // ignore
    }
  }, [session, activeRepoName, bootstrapping, loadDashboard]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_THRESHOLDS, JSON.stringify(thresholds));
    } catch {
      // ignore
    }
  }, [thresholds]);

  /* --------------------------------- data --------------------------------- */

  const sync = useCallback(async () => {
    if (!session?.authenticated || !activeRepoName) return;
    setSyncing(true);
    try {
      const payload = await api.sync(activeRepoName);
      setItems(payload.items);
      setStaleNotice(false);
      setRepos((prev) => prev.map((r) => (r.fullName === activeRepoName ? payload.repo : r)));
      const errs = payload.repo.sync.errors;
      if (errs.length > 0) push('error', `同步完成但有 ${errs.length} 个错误：${errs[0].message}`);
      else push('ok', `已同步 ${payload.items.length} 项${payload.incremental ? '（增量）' : '（全量）'}`);
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setSyncing(false);
    }
  }, [activeRepoName, push, session]);

  const openReport = useCallback(async () => {
    setReportOpen(true);
    setReportError(null);
    if (!session?.authenticated || !activeRepoName) {
      setReport(null);
      return;
    }
    setReportLoading(true);
    try {
      const { report: r } = await api.report(activeRepoName, thresholds);
      setReport(r);
    } catch (err) {
      setReportError((err as Error).message);
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  }, [activeRepoName, session, thresholds]);

  /* ------------------------------ derived UI ------------------------------ */

  const activeRepo = useMemo(
    () => repos.find((r) => r.fullName === activeRepoName) ?? null,
    [repos, activeRepoName],
  );

  const visibleItems = useMemo(() => {
    const onBoard = boardItems(items, thresholds);
    const filtered = onBoard.filter((item) => matchesFilters(item, filters, thresholds));
    return sortItems(filtered, sort);
  }, [items, thresholds, filters, sort]);

  const buckets = useMemo(() => groupByBucket(visibleItems, thresholds), [visibleItems, thresholds]);

  const selectedItem = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);
  const checkedItems = useMemo(() => visibleItems.filter((i) => checked.has(i.id)), [visibleItems, checked]);

  const toggleCheck = useCallback((id: string, next: boolean) => {
    setChecked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);

  /* ------------------------------ keyboard -------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

      if (e.key === '/' && !typing) {
        e.preventDefault();
        document.getElementById('repoops-search')?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (reportOpen) setReportOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (selectedId) setSelectedId(null);
        else if (sidebarOpen) setSidebarOpen(false);
        return;
      }
      if (typing) return;

      // j/k walks the visible board in column order.
      if (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const flat = (['triage', 'review', 'author', 'stalled', 'done'] as const).flatMap((b) => buckets[b]);
        if (flat.length === 0) return;
        e.preventDefault();
        const idx = flat.findIndex((i) => i.id === selectedId);
        const next =
          e.key === 'j' || e.key === 'ArrowDown'
            ? Math.min(flat.length - 1, idx + 1)
            : Math.max(0, idx <= 0 ? 0 : idx - 1);
        setSelectedId(flat[next].id);
      }
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void sync();
      }
      if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void sync();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [buckets, reportOpen, settingsOpen, selectedId, sidebarOpen, sync]);

  /* ------------------------------- handlers ------------------------------- */

  const handleAddRepo = async (fullName: string) => {
    const { repo } = await api.addRepo(fullName);
    setRepos((prev) => [...prev.filter((r) => r.fullName !== repo.fullName), repo]);
    setActiveRepoName(repo.fullName);
    setSettingsOpen(false);
    push('ok', `已添加 ${repo.fullName}`);
  };

  const handleRemoveRepo = async (fullName: string) => {
    await api.removeRepo(fullName);
    setRepos((prev) => prev.filter((r) => r.fullName !== fullName));
    if (activeRepoName === fullName) {
      const next = repos.find((r) => r.fullName !== fullName);
      setActiveRepoName(next?.fullName ?? null);
      setItems([]);
    }
    push('ok', `已移除 ${fullName}（缓存已清除）`);
  };

  const handleTokenLogin = async (token: string) => {
    await api.tokenLogin(token);
    const info = await api.session();
    setSession(info);
    const { repos: list } = await api.repos();
    setRepos(list);
    if (list[0]) setActiveRepoName(list[0].fullName);
    setSettingsOpen(false);
  };

  const handleDisconnect = async () => {
    await api.logout();
    const info = await api.session();
    setSession(info);
    setRepos([]);
    setItems([]);
    setChecked(new Set());
    setSelectedId(null);
    setActiveRepoName(info.demoRepo);
    setSettingsOpen(false);
    push('ok', '已断开连接并删除本地数据');
  };

  const [authBanner, setAuthBanner] = useState<{ ok: boolean; reason: string | null } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (auth) {
      const reason = params.get('reason');
      window.history.replaceState({}, '', window.location.pathname);
      return { ok: auth === 'ok', reason };
    }
    // Landed back here from github.com without an `auth` result: the redirect or
    // the token exchange never completed (blocked network, cancelled consent, or
    // a stale state cookie). Say so instead of silently showing the demo.
    if (typeof document !== 'undefined' && /(^|\.)github\.com$/.test(new URL(document.referrer || 'https://x.invalid').hostname)) {
      return { ok: false, reason: 'interrupted' };
    }
    return null;
  });

  // Auto-dismiss the one-shot auth result banner: it is a toast-like hint, not
  // persistent state, and it used to sit there forever saying "adding a repo"
  // even after the user had added several.
  useEffect(() => {
    if (!authBanner?.ok) return;
    const t = window.setTimeout(() => setAuthBanner(null), 8000);
    return () => window.clearTimeout(t);
  }, [authBanner]);

  /* --------------------------------- render ------------------------------ */

  if (bootstrapping) {
    return (
      <div className="app" style={{ gridTemplateColumns: '1fr' }}>
        <div className="app__main">
          <div className="empty-state">
            <span className="spinner" style={{ width: 22, height: 22 }} />
            <div className="empty-state__title">正在加载工作区…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        session={session}
        repos={repos}
        activeRepo={activeRepoName}
        open={sidebarOpen}
        onSelect={(name) => {
          setActiveRepoName(name);
          setSidebarOpen(false);
          setSelectedId(null);
        }}
        onAdd={() => setSettingsOpen(true)}
        onClose={() => setSidebarOpen(false)}
      />

      {sidebarOpen && (
        <div
          className="mobile-only"
          onClick={() => setSidebarOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 55 }}
          aria-hidden
        />
      )}

      <div className="app__main">
        <TopBar
          session={session}
          repo={activeRepo}
          mode={mode}
          query={filters.query}
          onQuery={(q) => setFilters((f) => ({ ...f, query: q }))}
          onSync={sync}
          syncing={syncing}
          onMenu={() => setSidebarOpen(true)}
          onTheme={toggleTheme}
          theme={theme}
          onReport={openReport}
          reportEnabled={items.length > 0}
          onSettings={() => setSettingsOpen(true)}
          staleNotice={staleNotice}
        />

        {authBanner && (
          <div className="banner-slot">
            <div className={`notice ${authBanner.ok ? 'notice--ok' : 'notice--error'}`}>
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                {authBanner.ok ? (
                  <>
                    GitHub 授权成功{session?.login ? `（@${session.login}）` : ''}。
                    {repos.length > 0 ? '已载入你之前跟踪的仓库。' : '添加一个仓库就可以开始了。'}
                  </>
                ) : authBanner.reason === 'interrupted' ? (
                  <>
                    从 GitHub 回来了，但授权没有完成 —— 通常是因为 <code>github.com</code> 在你当前网络打不开、页面被中断，或者你在
                    GitHub 上取消了授权。
                    <button className="btn btn--sm" style={{ marginLeft: 6 }} onClick={() => setSettingsOpen(true)}>
                      改用只读 Token 连接
                    </button>
                  </>
                ) : (
                  `GitHub 授权失败：${authBanner.reason ?? '未知原因'}。可以重试，或改用只读 Token 连接。`
                )}
              </span>
            </div>
          </div>
        )}

        {loadError && (
          <div className="banner-slot">
            <div className="notice notice--error">
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                {loadError}
                <button
                  className="btn btn--sm"
                  style={{ marginLeft: 10 }}
                  onClick={() => activeRepoName && loadDashboard(activeRepoName, Boolean(session?.authenticated))}
                >
                  重试
                </button>
              </span>
            </div>
          </div>
        )}

        {/* Only claim "demo data" when the visitor is really unauthenticated. */}
        {!session?.authenticated && (
          <div className="banner-slot banner-slot--demo">
            <div className="notice notice--warn demo-banner">
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                <strong>演示数据</strong>
                <span className="demo-banner__detail">
                  ：{activeRepoName ?? 'honojs/hono'} 的真实公开 GitHub 数据快照（只读、每 6 小时刷新，与任何登录用户的工作区物理隔离）
                  {staleNotice ? '，当前为缓存快照（GitHub 暂时不可达）' : ''}
                </span>
                <span className="demo-banner__short"> · 只读快照</span>
                <button className="btn btn--sm" style={{ marginLeft: 6 }} onClick={() => setSettingsOpen(true)}>
                  连接 GitHub
                </button>
              </span>
            </div>
          </div>
        )}

        <div className="app__body">
          <div className="board-area" ref={searchRef}>
            {session?.authenticated && repos.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__title">已连接 @{session.login}，添加第一个仓库</div>
                <div className="empty-state__text">
                  输入 <code>owner/name</code>（或粘贴 github.com 链接）。RepoOps 会用你的令牌拉取 Issues 与 PR，
                  建立「待处理 / 等待审查 / 等待作者 / 已停滞 / 近期完成」五个队列。
                </div>
                <form
                  className="row"
                  style={{ width: 'min(520px, 100%)', gap: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const value = firstRepoInput.trim();
                    if (!value || firstRepoBusy) return;
                    setFirstRepoBusy(true);
                    setFirstRepoError(null);
                    handleAddRepo(value)
                      .then(() => setFirstRepoInput(''))
                      .catch((err) => setFirstRepoError((err as Error).message))
                      .finally(() => setFirstRepoBusy(false));
                  }}
                >
                  <input
                    className="select"
                    data-testid="first-repo-input"
                    style={{ flex: 1, padding: '9px 10px', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                    placeholder="owner/name 或 https://github.com/owner/name"
                    value={firstRepoInput}
                    onChange={(e) => setFirstRepoInput(e.target.value)}
                    aria-label="要添加的仓库"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button className="btn btn--primary" type="submit" disabled={!firstRepoInput.trim() || firstRepoBusy}>
                    <IconPlus size={13} />
                    {firstRepoBusy ? '同步中…' : '添加并同步'}
                  </button>
                </form>
                {firstRepoError && (
                  <div className="notice notice--error" style={{ maxWidth: 520 }} data-testid="first-repo-error">
                    <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
                    <span>{firstRepoError}</span>
                  </div>
                )}
                <div className="faint" style={{ fontSize: 11.5, maxWidth: 520 }}>
                  只想先看看？左侧仓库列表里的演示仓库随时可以切换过去。
                </div>
              </div>
            ) : (
              <>
                <Toolbar
                  filters={filters}
                  onFilters={setFilters}
                  sort={sort}
                  onSort={setSort}
                  thresholds={thresholds}
                  onThresholds={setThresholds}
                  items={items}
                  resultCount={visibleItems.length}
                  totalCount={items.length}
                  selectedCount={checked.size}
                  onClearSelection={() => setChecked(new Set())}
                  onSelectAll={() => setChecked(new Set(visibleItems.map((i) => i.id)))}
                />
                <Board
                  buckets={buckets}
                  selectedId={selectedId}
                  checked={checked}
                  onOpen={(item) => setSelectedId(item.id)}
                  onToggleCheck={toggleCheck}
                  staleDays={thresholds.staleDays}
                  loading={loading}
                />
                <BatchBar
                  items={checkedItems}
                  thresholds={thresholds}
                  onClear={() => setChecked(new Set())}
                  onToast={push}
                />
              </>
            )}
          </div>

          {selectedItem && (
            <DetailPanel
              item={selectedItem}
              thresholds={thresholds}
              onClose={() => setSelectedId(null)}
              onToast={push}
            />
          )}
        </div>
      </div>

      {reportOpen && activeRepoName && (
        <ReportModal
          repoFullName={activeRepoName}
          items={items}
          thresholds={thresholds}
          serverReport={report}
          reportError={reportError}
          loading={reportLoading}
          onClose={() => setReportOpen(false)}
          onCopy={push}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          session={session}
          repos={repos}
          activeRepo={activeRepo}
          onClose={() => setSettingsOpen(false)}
          onAddRepo={handleAddRepo}
          onRemoveRepo={handleRemoveRepo}
          onTokenLogin={handleTokenLogin}
          onDisconnect={handleDisconnect}
          onToast={push}
        />
      )}

      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 200,
          width: 'min(440px, calc(100vw - 24px))',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`notice notice--${t.kind === 'ok' ? 'ok' : t.kind === 'error' ? 'error' : 'warn'}`}
            style={{ pointerEvents: 'auto', boxShadow: 'var(--shadow-lg)', background: 'var(--bg-elev)' }}
            onClick={() => dismiss(t.id)}
            role="status"
            data-testid="toast"
          >
            <span style={{ flex: 1 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
