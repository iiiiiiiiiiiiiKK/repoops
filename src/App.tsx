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
  const [mode, setMode] = useState<'live' | 'demo'>('demo');
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
          setMode('live');
          setStaleNotice(false);
          setRepos((prev) => prev.map((r) => (r.fullName === repoName ? { ...r, ...payload.repo } : r)));
        } else {
          const payload = await api.demo(repoName);
          setItems(payload.items);
          setMode('demo');
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
      setMode('live');
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

  const authBanner = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (!auth) return null;
    const reason = params.get('reason');
    window.history.replaceState({}, '', window.location.pathname);
    return { ok: auth === 'ok', reason };
  }, []);

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
          <div style={{ padding: '8px 14px 0' }}>
            <div className={`notice ${authBanner.ok ? 'notice--ok' : 'notice--error'}`}>
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                {authBanner.ok
                  ? 'GitHub 授权成功，正在同步你的仓库列表。'
                  : `GitHub 授权失败：${authBanner.reason ?? '未知原因'}。可以重试，或改用只读 Token 连接。`}
              </span>
            </div>
          </div>
        )}

        {loadError && (
          <div style={{ padding: '8px 14px 0' }}>
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

        {mode === 'demo' && (
          <div style={{ padding: '8px 14px 0' }}>
            <div className="notice notice--warn">
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                当前展示的是 <strong>演示数据</strong>：{activeRepoName} 的真实公开 GitHub 数据快照（只读、每 6 小时刷新，
                与任何登录用户的工作区物理隔离）
                {staleNotice ? '，当前为缓存快照（GitHub 暂时不可达）' : ''}。
                {!session?.authenticated && (
                  <>
                    {' '}
                    <button className="btn btn--sm" style={{ marginLeft: 6 }} onClick={() => setSettingsOpen(true)}>
                      连接 GitHub
                    </button>
                  </>
                )}
              </span>
            </div>
          </div>
        )}

        <div className="app__body">
          <div className="board-area" ref={searchRef}>
            {session?.authenticated && repos.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__title">还没有添加仓库</div>
                <div className="empty-state__text">
                  输入一个 <code>owner/name</code>，RepoOps 会用你的令牌拉取 Issues 与 PR，并立即建立五个队列。
                </div>
                <button className="btn btn--primary" onClick={() => setSettingsOpen(true)}>
                  <IconPlus size={13} />
                  添加仓库
                </button>
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
