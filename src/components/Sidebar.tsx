import type { SessionInfo, TrackerRepo } from '../../shared/types';
import { IconGithub, IconPlus, IconXSocial, IconExternal } from './Icons';
import { compactNumber, relativeTime, repoInitials } from '../lib/format';

export const AUTHOR_X_URL = 'https://x.com/0xkillcoin';
export const AUTHOR_X_HANDLE = '@0xkillcoin';

interface Props {
  session: SessionInfo | null;
  repos: TrackerRepo[];
  activeRepo: string | null;
  open: boolean;
  onSelect: (fullName: string) => void;
  onAdd: () => void;
  onClose: () => void;
}

export function Sidebar({ session, repos, activeRepo, open, onSelect, onAdd, onClose }: Props) {
  return (
    <aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="工作区导航">
      <div className="sidebar__brand">
        <div className="brand__mark">R</div>
        <div className="brand__text">
          <div className="brand__name">RepoOps</div>
          <div className="brand__sub">开源维护者作战室</div>
        </div>
        <button className="btn btn--ghost btn--icon mobile-only" onClick={onClose} aria-label="关闭导航" style={{ marginLeft: 'auto' }}>
          <IconXSocial size={13} />
        </button>
      </div>

      <div className="sidebar__scroll">
        <div className="sidebar__section">
          <div className="sidebar__label">
            <span>仓库 {repos.length ? `(${repos.length})` : ''}</span>
            {session?.authenticated && (
              <button className="btn btn--ghost btn--sm" onClick={onAdd} title="添加仓库">
                <IconPlus size={12} />
                添加
              </button>
            )}
          </div>

          {repos.length === 0 ? (
            <div style={{ padding: '4px 9px 8px', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.6 }}>
              {session?.authenticated
                ? '还没有仓库。点击「添加」输入 owner/name。'
                : '演示模式下展示公开仓库快照。连接 GitHub 后可加入自己的仓库。'}
            </div>
          ) : (
            <div className="repo-list">
              {repos.map((repo) => {
                const active = repo.fullName === activeRepo;
                const stalled = repo.sync.errors.length;
                return (
                  <button
                    key={repo.fullName}
                    className={`repo-item${active ? ' repo-item--active' : ''}`}
                    onClick={() => onSelect(repo.fullName)}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="repo-item__avatar">{repoInitials(repo.fullName)}</span>
                    <span className="repo-item__body">
                      <span className="repo-item__name">{repo.fullName}</span>
                      <span className="repo-item__meta">
                        {repo.sync.lastSyncAt
                          ? `${repo.sync.itemCount} 项 · 同步 ${relativeTime(repo.sync.lastSyncAt)}`
                          : '尚未同步'}
                        {stalled > 0 ? ` · ${stalled} 个错误` : ''}
                      </span>
                    </span>
                    {repo.isPrivate ? <span className="chip" style={{ fontSize: 9.5, padding: '0 5px' }}>私有</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar__section">
          <div className="sidebar__label">
            <span>连接</span>
          </div>
          <div style={{ padding: '0 9px', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.7 }}>
            {session?.authenticated ? (
              <>
                <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                  <IconGithub size={13} />
                  <span className="mono" style={{ color: 'var(--text)' }}>{session.login}</span>
                </div>
                <div>Scopes: {session.scopes.length ? session.scopes.join(', ') : '—'}</div>
                {session.tokenExpiresAt ? <div>令牌到期：{relativeTime(session.tokenExpiresAt)}</div> : <div>令牌：长期有效</div>}
              </>
            ) : session?.oauthConfigured ? (
              '未连接 GitHub — 当前为公开只读演示。'
            ) : (
              '此部署未配置 OAuth App，使用演示数据或粘贴只读 Token。'
            )}
          </div>
        </div>
      </div>

      <div className="sidebar__footer">
        <a
          className="author-card"
          href={AUTHOR_X_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`作者 X 主页 ${AUTHOR_X_HANDLE}`}
        >
          <span className="author-card__x" aria-hidden>𝕏</span>
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>作者</span>
            <span className="author-card__handle">{AUTHOR_X_HANDLE}</span>
          </span>
          <IconExternal size={11} style={{ marginLeft: 'auto', opacity: 0.6 }} />
        </a>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', display: 'flex', justifyContent: 'space-between' }}>
          <span>v1.0.0</span>
          <span>
            {repos.reduce((sum, r) => sum + (r.stargazers ?? 0), 0) > 0
              ? `${compactNumber(repos.reduce((sum, r) => sum + (r.stargazers ?? 0), 0))} stars 跟踪中`
              : '只读 · 不写入仓库'}
          </span>
        </div>
      </div>
    </aside>
  );
}
