import { useState } from 'react';
import type { SessionInfo, TrackerRepo, SyncState } from '../../shared/types';
import { IconCheck, IconCopy, IconExternal, IconGithub, IconWarn, IconX } from './Icons';
import { copyToClipboard, dateTime, relativeTime } from '../lib/format';
import { AUTHOR_X_URL } from './Sidebar';

interface Props {
  session: SessionInfo | null;
  repos: TrackerRepo[];
  activeRepo: TrackerRepo | null;
  onClose: () => void;
  onAddRepo: (fullName: string) => Promise<void>;
  onRemoveRepo: (fullName: string) => Promise<void>;
  onTokenLogin: (token: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onToast: (kind: 'ok' | 'error' | 'info', message: string) => void;
}

type Tab = 'connect' | 'repos' | 'sync' | 'about';

export function SettingsModal({
  session,
  repos,
  activeRepo,
  onClose,
  onAddRepo,
  onRemoveRepo,
  onTokenLogin,
  onDisconnect,
  onToast,
}: Props) {
  const [tab, setTab] = useState<Tab>('connect');
  const [repoInput, setRepoInput] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sync: SyncState | null = activeRepo?.sync ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置与连接"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-modal"
      >
        <div className="modal__head">
          <h3 className="modal__title">设置与连接</h3>
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="关闭" style={{ marginLeft: 'auto' }}>
            <IconX size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 2, padding: '0 12px', borderBottom: '1px solid var(--border)' }} role="tablist" aria-label="设置分区">
          {(
            [
              ['connect', '连接'],
              ['repos', '仓库'],
              ['sync', '同步状态'],
              ['about', '关于'],
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

        <div className="modal__body">
          {error && (
            <div className="notice notice--error" style={{ marginBottom: 12 }}>
              <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}

          {tab === 'connect' && (
            <>
              {session?.authenticated ? (
                <>
                  <div className="field">
                    <span className="field__label">当前账号</span>
                    <div className="row">
                      {session.avatarUrl && (
                        <img src={session.avatarUrl} alt="" width={28} height={28} style={{ borderRadius: '50%' }} />
                      )}
                      <strong>{session.login}</strong>
                      <span className="chip chip--live">已授权</span>
                    </div>
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
                      已申请权限：{session.scopes.length ? session.scopes.join(', ') : '—'}
                      {session.tokenExpiresAt ? ` · 令牌到期 ${relativeTime(session.tokenExpiresAt)}` : ''}
                    </div>
                  </div>
                  <div className="notice notice--warn" style={{ marginBottom: 12 }}>
                    <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
                    <span>
                      断开连接会删除本部署上的会话、仓库关联、缓存条目、同步状态和周报记录。GitHub 上的 Issue / PR 完全不受影响。
                    </span>
                  </div>
                  {confirmDisconnect ? (
                    <div className="row">
                      <button
                        className="btn btn--danger"
                        disabled={busy === 'disconnect'}
                        onClick={() => run('disconnect', onDisconnect)}
                      >
                        {busy === 'disconnect' ? '正在删除…' : '确认断开并删除本地数据'}
                      </button>
                      <button className="btn btn--ghost" onClick={() => setConfirmDisconnect(false)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn--danger" onClick={() => setConfirmDisconnect(true)}>
                      断开 GitHub 连接
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="field">
                    <span className="field__label">方式一 · GitHub OAuth（推荐）</span>
                    <p className="dim" style={{ fontSize: 12.5, marginTop: 0 }}>
                      跳转到 GitHub 授权页面，只申请完成任务所需的最小权限：<code>read:user</code> + <code>public_repo</code>。
                      需要访问私有仓库时可在授权链接上加 <code>?private=1</code>，那会升级为 <code>repo</code> 域。
                    </p>
                    {session?.oauthConfigured ? (
                      <a className="btn btn--primary" href="/api/auth/login">
                        <IconGithub size={14} />
                        用 GitHub 登录
                      </a>
                    ) : (
                      <div className="notice notice--warn">
                        <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
                        <span>
                          此部署没有配置 <code>GITHUB_CLIENT_ID</code> / <code>GITHUB_CLIENT_SECRET</code>，OAuth 不可用。
                          可以继续使用公开演示数据，或在下方粘贴一个只读 Token。配置方法见 README 的「OAuth 配置指南」。
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="field">
                    <span className="field__label">方式二 · 粘贴只读 Token（fallback）</span>
                    <p className="dim" style={{ fontSize: 12.5, marginTop: 0 }}>
                      适合已经有 fine-grained PAT 的维护者。Token 只在工作进程内校验一次，随后以 AES-GCM 加密存入 D1，
                      永远不会回传给浏览器。建议只勾选 Public repositories 的 <code>Metadata: Read-only</code> 与{' '}
                      <code>Issues: Read-only</code>、<code>Pull requests: Read-only</code>。
                    </p>
                    <div className="row">
                      <input
                        className="select"
                        style={{ flex: 1, minWidth: 180, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
                        type="password"
                        placeholder="ghp_… 或 github_pat_…"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        aria-label="GitHub Token"
                        autoComplete="off"
                      />
                      <button
                        className="btn btn--primary"
                        disabled={!token.trim() || busy === 'token'}
                        onClick={() =>
                          run('token', async () => {
                            await onTokenLogin(token.trim());
                            setToken('');
                            onToast('ok', '连接成功');
                          })
                        }
                      >
                        {busy === 'token' ? '校验中…' : '连接'}
                      </button>
                    </div>
                    <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                      提示：此 Token 只应具备只读权限；RepoOps 从不调用任何写入接口。
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'repos' && (
            <>
              {session?.authenticated ? (
                <div className="field">
                  <span className="field__label">添加仓库</span>
                  <div className="row">
                    <input
                      className="select"
                      style={{ flex: 1, minWidth: 180, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                      placeholder="owner/name 或 https://github.com/owner/name"
                      value={repoInput}
                      onChange={(e) => setRepoInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && repoInput.trim()) {
                          run('add', async () => {
                            await onAddRepo(repoInput.trim());
                            setRepoInput('');
                          });
                        }
                      }}
                      aria-label="仓库全名"
                    />
                    <button
                      className="btn btn--primary"
                      disabled={!repoInput.trim() || busy === 'add'}
                      onClick={() =>
                        run('add', async () => {
                          await onAddRepo(repoInput.trim());
                          setRepoInput('');
                        })
                      }
                    >
                      {busy === 'add' ? '同步中…' : '添加并同步'}
                    </button>
                  </div>
                  <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                    首次同步最多拉取 600 项（6 页 × 100）。私有仓库需要授权时选择 <code>repo</code> 域。
                  </div>
                </div>
              ) : (
                <div className="notice notice--warn" style={{ marginBottom: 12 }}>
                  <span>未连接 GitHub 时只能查看公开演示仓库。连接后可以添加自己的仓库。</span>
                </div>
              )}

              <div className="field">
                <span className="field__label">已跟踪仓库（{repos.length}）</span>
                {repos.length === 0 ? (
                  <div className="faint" style={{ fontSize: 12 }}>还没有仓库。</div>
                ) : (
                  <div className="stack">
                    {repos.map((repo) => (
                      <div
                        key={repo.fullName}
                        className="row"
                        style={{
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-inset)',
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{repo.fullName}</div>
                          <div className="faint" style={{ fontSize: 11 }}>
                            {repo.sync.itemCount} 项 · 同步 {repo.sync.lastSyncAt ? relativeTime(repo.sync.lastSyncAt) : '从未'}
                          </div>
                        </div>
                        {confirmRemove === repo.fullName ? (
                          <div className="row" style={{ gap: 4 }}>
                            <button
                              className="btn btn--danger btn--sm"
                              onClick={() =>
                                run('remove', async () => {
                                  await onRemoveRepo(repo.fullName);
                                  setConfirmRemove(null);
                                })
                              }
                            >
                              确认移除
                            </button>
                            <button className="btn btn--ghost btn--sm" onClick={() => setConfirmRemove(null)}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn--sm btn--ghost" onClick={() => setConfirmRemove(repo.fullName)}>
                            移除
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'sync' && (
            <>
              {!sync ? (
                <div className="faint">尚未选择仓库或还没有同步记录。</div>
              ) : (
                <>
                  <div className="field">
                    <span className="field__label">上次同步</span>
                    <div className="field__value mono" style={{ fontSize: 11.5, lineHeight: 1.9 }}>
                      时间：{sync.lastSyncAt ? dateTime(sync.lastSyncAt) : '从未同步'}
                      <br />
                      抓取页数：{sync.pagesFetched}
                      <br />
                      缓存条目：{sync.itemCount}
                      <br />
                      分页完整：{sync.complete ? '是（已到末页）' : '否（达到页数上限）'}
                      <br />
                      耗时：{sync.lastRunDurationMs !== null ? `${sync.lastRunDurationMs} ms` : '—'}
                      <br />
                      模式：{sync.mode === 'demo' ? '演示快照' : '实时同步'}
                      <br />
                      增量游标：{sync.cursor ?? '—'}
                    </div>
                  </div>

                  <div className="field">
                    <span className="field__label">GitHub API 配额</span>
                    {sync.rateLimit ? (
                      <div className="field__value mono" style={{ fontSize: 11.5, lineHeight: 1.9 }}>
                        剩余 {sync.rateLimit.remaining} / {sync.rateLimit.limit}（已用 {sync.rateLimit.used}）
                        <br />
                        重置时间：{dateTime(sync.rateLimit.resetAt)}（{relativeTime(sync.rateLimit.resetAt)}）
                        <br />
                        资源：{sync.rateLimit.resource}
                      </div>
                    ) : (
                      <div className="faint" style={{ fontSize: 12 }}>尚无配额快照。</div>
                    )}
                  </div>

                  <div className="field">
                    <span className="field__label">同步错误（{sync.errors.length}）</span>
                    {sync.errors.length === 0 ? (
                      <div className="notice notice--ok">
                        <IconCheck size={13} style={{ flex: 'none', marginTop: 2 }} />
                        <span>最近一次同步没有错误。</span>
                      </div>
                    ) : (
                      <div className="stack">
                        {sync.errors.map((e, i) => (
                          <div key={i} className="notice notice--error">
                            <IconWarn size={13} style={{ flex: 'none', marginTop: 2 }} />
                            <span>
                              {e.message}
                              <br />
                              <span className="faint">{dateTime(e.at)}{e.code ? ` · ${e.code}` : ''}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'about' && (
            <>
              <div className="field">
                <span className="field__label">RepoOps</span>
                <p className="dim" style={{ fontSize: 12.5 }}>
                  面向 GitHub 开源维护者的项目管理作战室。把 Issue 与 PR 拆成五个真实队列，找出停滞项、审查瓶颈，
                  并生成可以直接发布的维护周报。只读设计：不会自动评论、关闭或合并任何事项。
                </p>
              </div>
              <div className="field">
                <span className="field__label">作者</span>
                <div className="row">
                  <a className="btn btn--sm" href={AUTHOR_X_URL} target="_blank" rel="noopener noreferrer">
                    <span style={{ fontWeight: 800 }}>𝕏</span> @0xkillcoin
                    <IconExternal size={11} />
                  </a>
                  <button
                    className="btn btn--sm"
                    onClick={async () => {
                      const ok = await copyToClipboard(AUTHOR_X_URL);
                      setCopied(ok);
                      onToast(ok ? 'ok' : 'error', ok ? '作者链接已复制' : '复制失败');
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
                    复制链接
                  </button>
                </div>
              </div>
              <div className="field">
                <span className="field__label">隐私</span>
                <p className="dim" style={{ fontSize: 12 }}>
                  RepoOps 只存储完成任务所需的数据：GitHub 登录名、加密后的访问令牌、你添加的仓库列表、公开 Issue/PR 的缓存副本。
                  不收集分析埋点，不向第三方出售数据。完整说明见仓库中的 <code>docs/PRIVACY.md</code>。
                </p>
              </div>
            </>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
