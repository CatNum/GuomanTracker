"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Bookmark,
  Check,
  ExternalLink,
  ListVideo,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import Catalog from "./catalog";
import { isSupportedPlatform, platforms, type Anime } from "@/lib/catalog";
import {
  watchingQueue,
  latestPublishedEpisode,
  type Library,
  type WatchState,
  type WatchCandidate,
} from "@/lib/watching";
import {
  cloudApp,
  cloudCall,
  cloudConfigured,
  getAuthenticatedSession,
  sendEmailCode,
} from "@/lib/cloudbase-client";
import { endCloudSession, followCatalogSeries } from "@/lib/account-actions";
import { CloudActionError, emailErrorMessage, emailRetryDelayMs, inspectAuthenticatedSession, verifyEmailCode, type EmailChallenge } from "@/lib/cloud-auth";
import { isDefinitiveBusinessRejection, runLibraryOperation } from "@/lib/library-operation";
import { libraryBelongsToUser } from "@/lib/library-identity";

type Mode = "guest" | "cloud";
type View = "watch" | "library" | "catalog";
const monitoringLabels = {
  queued: "等待核验",
  active: "监控中",
  unsupported: "需人工核验",
  error: "最近扫描未完成",
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请稍后再试";

export default function Tracker({
  initial,
  checkedAt,
}: {
  initial: Anime[];
  checkedAt: string;
}) {
  const [mode, setMode] = useState<Mode>("guest"),
    [library, setLibrary] = useState<Library | null>(null),
    [view, setView] = useState<View>("watch");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [submitOpen, setSubmitOpen] = useState(false),
    [editing, setEditing] = useState<{
      series: Anime;
      follow: WatchState;
    } | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [needsLibraryRefresh, setNeedsLibraryRefresh] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false),
    [accountEmail, setAccountEmail] = useState(""),
    [email, setEmail] = useState(""),
    [token, setToken] = useState(""),
    [challenge, setChallenge] = useState<EmailChallenge | null>(null),
    [sending, setSending] = useState(false),
    [verifying, setVerifying] = useState(false),
    [resendAt, setResendAt] = useState(0),
    [loginError, setLoginError] = useState(""),
    [needsLibraryRetry, setNeedsLibraryRetry] = useState(false),
    [pendingAccount, setPendingAccount] = useState(false);
  const [now, setNow] = useState(Date.parse(checkedAt));
  const [cooldownNow, setCooldownNow] = useState(0);
  const authLock = useRef(false);
  const mutationLock = useRef(false);
  const needsLibraryRefreshRef = useRef(false);
  const generation = useRef(0);
  const modeRef = useRef<Mode>("guest");
  const mounted = useRef(true);
  const loginTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!loginOpen || !resendAt || Date.now() >= resendAt) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setCooldownNow(current);
      if (current >= resendAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [loginOpen, resendAt]);
  const call = useCallback(
    (action: string, payload: Record<string, unknown> = {}) => cloudCall(action, payload),
    [],
  );
  const reload = useCallback(
    async () => {
      if (modeRef.current === "guest") return null;
      const currentGeneration = generation.current;
      const data = (await call("library")) as Library;
      if (mounted.current && currentGeneration === generation.current && modeRef.current === "cloud") {
        setLibrary(data);
        return data;
      }
      return null;
    },
    [call],
  );
  useEffect(() => {
    let active = true;
    const generationRef = generation;
    mounted.current = true;
    async function initialize() {
      const currentGeneration = generation.current;
      let authenticated = false;
      let sessionUncertain = false;
      let sessionError: unknown;
      let verifiedAccountEmail = "";
      try {
        const checked = cloudConfigured ? await inspectAuthenticatedSession(getAuthenticatedSession) : null;
        if (!active || currentGeneration !== generation.current) return;
        authenticated = !!checked?.session;
        verifiedAccountEmail = checked?.session?.email || "";
        sessionUncertain = checked?.uncertain === true;
        sessionError = checked?.error;
        const selected: Mode = authenticated ? "cloud" : "guest";
        const data = selected === "guest" ? null : (await call("library")) as Library;
        if (!active || currentGeneration !== generation.current) return;
        if (selected === "cloud") {
          const session = await getAuthenticatedSession();
          if (!active || currentGeneration !== generation.current) return;
          if (
            !checked?.session ||
            !session ||
            session.userId !== checked.session.userId ||
            !libraryBelongsToUser(data, checked.session.userId)
          ) {
            throw new Error("账号会话已变化，未加载其他账号记录，请重新加载当前账号记录。");
          }
        }
        if (active && currentGeneration === generation.current) {
          setAccountEmail(verifiedAccountEmail);
          modeRef.current = selected;
          setMode(selected);
          setLibrary(data);
          if (sessionUncertain) {
            setPendingAccount(true);
            setNotice("账号状态暂未确认，可继续加载或退出账号：" + errorText(sessionError));
          }
        }
      } catch (error) {
        if (active && currentGeneration === generation.current) {
          setNotice("账号数据加载未完成：" + errorText(error));
          if (authenticated || sessionUncertain) {
            setPendingAccount(true);
            if (authenticated) {
              setNeedsLibraryRetry(true);
              setLoginOpen(true);
              setLoginError("账号已登录，云端记录加载失败；当前记录保留，可重试加载。");
            }
          }
        }
      } finally {
        if (active && currentGeneration === generation.current) setLoading(false);
      }
    }
    void initialize();
    const initialNow = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      active = false;
      mounted.current = false;
      generationRef.current++;
      clearInterval(timer);
      clearTimeout(initialNow);
    };
    // 首次挂载恢复可信 SDK 账号会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const queue = useMemo(
    () => watchingQueue(library?.series || [], library?.follows || [], now),
    [library, now],
  );
  const followed = library?.follows.map((x) => x.seriesId) || [];
  const supportedIds = new Set((library?.series || []).filter((series) => isSupportedPlatform(series.platform)).map((series) => series.id));
  const activeCount = library?.follows.filter((x) => !x.paused && supportedIds.has(x.seriesId)).length || 0;

  function markLibraryRefresh(value: boolean) {
    needsLibraryRefreshRef.current = value;
    setNeedsLibraryRefresh(value);
  }

  async function refreshLibrary() {
    if (mutationLock.current || modeRef.current === "guest") return;
    mutationLock.current = true;
    const selectedMode = modeRef.current;
    const currentGeneration = generation.current;
    const current = () => mounted.current && generation.current === currentGeneration && modeRef.current === selectedMode;
    setBusy(true);
    try {
      const data = await reload();
      if (!data || !current()) return;
      if (needsLibraryRefreshRef.current) {
        markLibraryRefresh(false);
        setEditing(null);
        setSubmitOpen(false);
      }
      setNotice("观看记录已刷新；更新时间以最近官网核验为准。");
      setDialogError("");
    } catch (error) {
      if (current()) setNotice("记录重新加载未完成，请稍后重试。" + errorText(error));
    } finally {
      mutationLock.current = false;
      if (current()) setBusy(false);
    }
  }

  async function perform(
    action: string,
    payload: Record<string, unknown>,
    message: string,
  ) {
    const selectedMode = modeRef.current;
    if (selectedMode === "guest") {
      setNotice("请先邮箱登录，再保存追番。");
      return false;
    }
    if (needsLibraryRefreshRef.current) {
      setNotice("请先重新加载记录，再继续保存。");
      return false;
    }
    if (mutationLock.current) return false;
    mutationLock.current = true;
    const currentGeneration = generation.current;
    const current = () => mounted.current && generation.current === currentGeneration && modeRef.current === selectedMode;
    setBusy(true);
    setNotice("");
    setDialogError("");
    try {
      const result = await runLibraryOperation(
        () => call(action, payload),
        async () => {
          if (!current()) throw new Error("账号已切换");
          const data = await reload();
          if (!data) throw new Error("账号已切换");
          return data;
        },
        isDefinitiveBusinessRejection,
      );
      if (!current()) return false;
      if (result.kind === "saved") {
        markLibraryRefresh(false);
        setNotice(message);
        return true;
      }
      if (result.kind === "saved-unrefreshed") {
        markLibraryRefresh(true);
        setNotice("已保存，展示待刷新。请重新加载记录后继续操作。");
        return true;
      }
      if (result.kind === "unknown" || (result.error instanceof CloudActionError && result.error.code === "CONFLICT")) {
        markLibraryRefresh(true);
        const text = result.kind === "unknown"
          ? "提交结果暂未确认，请先重新加载记录。"
          : "记录版本已变化，请先重新加载记录。";
        setNotice(text);
        setDialogError(text);
        return false;
      }
      setNotice(errorText(result.error));
      setDialogError(errorText(result.error));
      return false;
    } finally {
      mutationLock.current = false;
      if (current()) setBusy(false);
    }
  }
  function openLogin(event: React.MouseEvent<HTMLButtonElement>) {
    loginTrigger.current = event.currentTarget;
    setLoginError("");
    setCooldownNow(Date.now());
    setLoginOpen(true);
  }
  function closeLogin() {
    if (authLock.current) return;
    setLoginOpen(false);
    setLoginError("");
  }
  async function sendCode() {
    if (authLock.current || Date.now() < resendAt) return;
    authLock.current = true;
    setSending(true);
    setLoginError("");
    try {
      const next = await sendEmailCode(email);
      if (!mounted.current) return;
      setChallenge(next);
      setToken("");
      setResendAt(Date.now() + 60000);
      setCooldownNow(Date.now());
    } catch (error) {
      if (mounted.current) {
        setLoginError(emailErrorMessage(error));
        const delay = emailRetryDelayMs(error);
        if (delay !== null) {
          setResendAt(Date.now() + delay);
          setCooldownNow(Date.now());
        }
      }
    } finally {
      authLock.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function loadVerifiedLibrary() {
    const currentGeneration = generation.current;
    const identity = await getAuthenticatedSession();
    if (!mounted.current || currentGeneration !== generation.current) return;
    if (!identity) throw new Error("当前没有有效的邮箱账号会话，请重新登录。");
    const data = await cloudCall("library", {}) as Library;
    if (!mounted.current || currentGeneration !== generation.current) return;
    const session = await getAuthenticatedSession();
    if (!mounted.current || currentGeneration !== generation.current) return;
    if (
      !session ||
      session.userId !== identity.userId ||
      !libraryBelongsToUser(data, identity.userId)
    )
      throw new Error("账号会话已变化，请重新加载当前账号记录。");
    setAccountEmail(session.email || "");
    generation.current++;
    markLibraryRefresh(false);
    modeRef.current = "cloud";
    setMode("cloud");
    setLibrary(data);
    setBusy(false);
    setPendingAccount(false);
    setNeedsLibraryRetry(false);
    setEditing(null);
    setSubmitOpen(false);
    setLoginOpen(false);
    setChallenge(null);
    setToken("");
    setNotice("邮箱账号已登录，云端追番记录已加载。");
  }
  async function verifyCode() {
    if (authLock.current || !challenge) return;
    authLock.current = true;
    setVerifying(true);
    setLoginError("");
    let sessionMayExist = false;
    try {
      await verifyEmailCode((await cloudApp()).auth() as Parameters<typeof verifyEmailCode>[0], challenge, token, () => {
        sessionMayExist = true;
        if (mounted.current) setPendingAccount(true);
      });
      if (!mounted.current) return;
      setNeedsLibraryRetry(true);
      try { await loadVerifiedLibrary(); }
      catch (error) { if (mounted.current) setLoginError("账号已登录，云端记录加载失败；当前记录保留，可重试加载。" + errorText(error)); }
    } catch (error) {
      if (mounted.current) setLoginError(sessionMayExist
        ? "验证结果或账号会话暂未确认；当前记录保留，可重试加载或退出此账号。" + errorText(error)
        : emailErrorMessage(error));
    } finally {
      authLock.current = false;
      if (mounted.current) setVerifying(false);
    }
  }
  async function retryLibrary() {
    if (authLock.current) return;
    authLock.current = true;
    setVerifying(true);
    try { await loadVerifiedLibrary(); }
    catch (error) { if (mounted.current) setLoginError("云端记录仍未加载，当前记录保留，请稍后重试。" + errorText(error)); }
    finally {
      authLock.current = false;
      if (mounted.current) setVerifying(false);
    }
  }
  async function switchAccount() {
    if (authLock.current) return;
    authLock.current = true;
    setVerifying(true);
    try {
      await endCloudSession((await cloudApp()).auth(), () => {
        generation.current++;
        markLibraryRefresh(false);
        setPendingAccount(false);
        setNeedsLibraryRetry(false);
        setBusy(false);
        setChallenge(null);
        setToken("");
        setEmail("");
        setAccountEmail("");
        setLoginError("");
      });
    } catch (error) {
      if (mounted.current) setLoginError(errorText(error));
    } finally {
      authLock.current = false;
      if (mounted.current) setVerifying(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      const clear = () => {
        generation.current++;
        markLibraryRefresh(false);
        modeRef.current = "guest";
        setMode("guest");
        setLibrary(null);
        setBusy(false);
        setPendingAccount(false);
        setNeedsLibraryRetry(false);
        setLoginOpen(false);
        setChallenge(null);
        setToken("");
        setEmail("");
        setAccountEmail("");
        setLoginError("");
        setNotice("已退出当前账号。");
      };
      if (mode === "cloud" || pendingAccount || needsLibraryRetry)
        await endCloudSession((await cloudApp()).auth(), clear);
      else clear();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  function openOfficial(series: Anime) {
    if (mode !== "guest" && isSupportedPlatform(series.platform) && !needsLibraryRefreshRef.current)
      void perform(
        "open",
        { seriesId: series.id },
        "已打开官方平台，观看后请确认进度。",
      );
  }
  function openSubmission() {
    setDialogError("");
    setSubmitOpen(true);
  }
  function editProgress(data: { series: Anime; follow: WatchState }) {
    if (!isSupportedPlatform(data.series.platform)) return;
    setDialogError("");
    setEditing(data);
  }
  async function complete(series: Anime, follow: WatchState) {
    if (!isSupportedPlatform(series.platform)) return;
    const latest = latestPublishedEpisode(series, now);
    if (
      latest === null ||
      Math.max(1, follow.currentEpisode + Number(follow.episodeCompleted)) >
        latest
    )
      return;
    await perform(
      "progress",
      {
        seriesId: series.id,
        currentEpisode: Math.max(
          1,
          follow.currentEpisode + Number(follow.episodeCompleted),
        ),
        episodeCompleted: true,
        paused: follow.paused,
        version: follow.version,
      },
      "已记录看完一集。",
    );
  }

  return (
    <div className="site-shell tracker-shell">
      <header className="site-header">
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Play size={19} fill="currentColor" />
          </span>
          <b>
            国漫<span>追更</span>
          </b>
          <span className="brand-en">GUOMAN TRACKER</span>
        </Link>
        <div className="account-menu">
          {mode === "guest" ? (
            <>
              {pendingAccount && <span>账号连接待恢复</span>}
              <button className="secondary-action" onClick={openLogin} disabled={busy || loading}>
                {pendingAccount ? "继续加载" : "邮箱登录"}
              </button>
              {pendingAccount && <button className="text-action" onClick={logout} disabled={busy || loading}>退出账号</button>}
            </>
          ) : (
            <>
              <span className="account-email">
                {accountEmail || library?.user.displayName || "我的账号"}
              </span>
              <button className="text-action" disabled={busy} onClick={logout}>
                退出
              </button>
            </>
          )}
        </div>
      </header>
      <main>
        <nav className="tracker-nav" aria-label="主导航">
          {(
            [
              ["watch", "现在看什么", Play],
              ["library", "我的追番", Bookmark],
              ["catalog", "国漫合集", Search],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              aria-current={view === key ? "page" : undefined}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
          <button className="submit-entry" onClick={openSubmission}>
            <Plus size={17} />
            补录动漫
          </button>
        </nav>
        {notice && (
          <div role="status" className="notice">
            <span>{notice}</span>
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {needsLibraryRefresh && mode !== "guest" && (
          <div className="notice" role="status">
            <span>当前记录等待重新加载，保存操作已暂停。</span>
            <button className="secondary-action" disabled={busy} onClick={() => void refreshLibrary()}>
              <RefreshCw size={14} />重新加载记录
            </button>
          </div>
        )}
        {loading ? (
          <div className="workspace-empty">正在恢复观看记录…</div>
        ) : (
          <>
            {view === "catalog" ? (
              <Catalog
                initial={initial}
                checkedAt={checkedAt}
                embedded
                followed={followed}
                onFollow={(series) => {
                  if (!busy && !needsLibraryRefreshRef.current)
                    void followCatalogSeries(
                      series,
                      [...initial, ...(library?.series || [])],
                      (action, payload) =>
                        perform(
                          action,
                          payload,
                          `已追番《${series.title}》，可以设置观看进度。`,
                        ),
                    );
                }}
              />
            ) : (
              <>
                <div className="workspace-title">
                  <div>
                    <div className="eyebrow">
                      <span />
                      {view === "watch" ? "从你的观看记录出发" : "你的故事进度"}
                    </div>
                    <h1>
                      {view === "watch" ? (
                        <>
                          现在，<span>看什么？</span>
                        </>
                      ) : (
                        <>
                          我的<span>追番。</span>
                        </>
                      )}
                    </h1>
                    <p>
                      {view === "watch"
                        ? "把已更新、还没看、想继续的故事，放在一起。"
                        : "记住看到哪里，下次接着看。"}
                    </p>
                  </div>
                  {mode !== "guest" && (
                    <button
                      className="sync-button"
                      disabled={busy}
                      onClick={() => void refreshLibrary()}
                    >
                      <RefreshCw size={14} />
                      刷新记录
                    </button>
                  )}
                </div>
                {mode === "guest" ? (
                  <section className="welcome-panel">
                    <div>
                      <ListVideo size={36} />
                      <h2>下次打开，就知道接着看什么</h2>
                      <p>
                        追番、记录看过的集数、挑选未看更新。无论是休息片刻，还是一段完整的闲暇。
                      </p>
                      <div className="action-row">
                        <button
                          className="primary-action"
                          onClick={openLogin}
                          disabled={busy}
                        >
                          邮箱登录并保存进度
                        </button>
                      </div>
                      <small>
                        {cloudConfigured
                          ? "登录后记录会随邮箱账号保存。"
                          : "邮箱登录暂未配置，当前可以先浏览合集。"}
                      </small>
                    </div>
                  </section>
                ) : (
                  <>
                    <div className="watch-stats">
                      <div>
                        <strong>{activeCount}</strong>
                        <span>正在追番</span>
                      </div>
                      <div>
                        <strong>{queue.ready.length}</strong>
                        <span>有未看内容</span>
                      </div>
                      <div>
                        <strong>{queue.caughtUp.length}</strong>
                        <span>已追平</span>
                      </div>
                      <div>
                        <strong>{queue.unknown.length}</strong>
                        <span>更新待核验</span>
                      </div>
                    </div>
                    {view === "watch" ? (
                      <>
                        {queue.ready.length > 0 ? (
                          <>
                            <section
                              className="featured-watch"
                              aria-label="优先观看"
                            >
                              <div className="featured-cover">
                                {queue.ready[0].series.cover && (
                                  <img
                                    src={queue.ready[0].series.cover}
                                    alt=""
                                    referrerPolicy="no-referrer"
                                    onError={(e) => {
                                      e.currentTarget.style.display = "none";
                                    }}
                                  />
                                )}
                                <span>
                                  <Play size={42} />
                                </span>
                              </div>
                              <div className="featured-body">
                                <span className="small-label">
                                  {!queue.ready[0].follow.episodeCompleted &&
                                  queue.ready[0].follow.currentEpisode > 0
                                    ? "接着上次的故事"
                                    : "有未看内容"}
                                </span>
                                <h2>{queue.ready[0].series.title}</h2>
                                <p>
                                  {progressLabel(queue.ready[0].follow)} ·
                                  已核验至第 {queue.ready[0].latestEpisode} 集
                                </p>
                                <div className="next-episode">
                                  从第 <b>{queue.ready[0].nextEpisode}</b>{" "}
                                  集继续{" "}
                                  <span>
                                    还有 {queue.ready[0].unwatched} 集未看
                                  </span>
                                </div>
                                <PlaybackActions
                                  candidate={queue.ready[0]}
                                  busy={busy || needsLibraryRefresh}
                                  onOpen={openOfficial}
                                  onEdit={editProgress}
                                  onComplete={complete}
                                />
                                <Verification
                                  series={queue.ready[0].series}
                                  stale={queue.ready[0].stale}
                                />
                              </div>
                            </section>
                            <div className="section-heading">
                              <h2>其他可以看的</h2>
                              <span>
                                {Math.max(0, queue.ready.length - 1)} 部
                              </span>
                            </div>
                            <div className="watch-grid">
                              {queue.ready.slice(1).map((candidate) => (
                                <WatchCard
                                  key={candidate.series.id}
                                  candidate={candidate}
                                  busy={busy || needsLibraryRefresh}
                                  onOpen={openOfficial}
                                  onEdit={editProgress}
                                  onComplete={complete}
                                />
                              ))}
                            </div>
                          </>
                        ) : (
                          <EmptyWorkspace
                            title={
                              activeCount
                                ? "当前没有已核验的未看内容"
                                : "先加入几部想追的国漫"
                            }
                            description={
                              activeCount
                                ? "已追平的作品和待核验的作品列在下方。"
                                : "从合集加入追番，设置已看集数，就能生成你的观看清单。"
                            }
                            onBrowse={() => setView("catalog")}
                            onSubmit={openSubmission}
                          />
                        )}
                        {queue.unknown.length > 0 && (
                          <section className="secondary-list">
                            <h2>
                              更新待核验 <span>{queue.unknown.length}</span>
                            </h2>
                            <p>
                              这些作品还没有可靠的最新集数，暂时不计入未看更新。
                            </p>
                            {queue.unknown.map((candidate) => (
                              <WatchCard
                                key={candidate.series.id}
                                candidate={candidate}
                                busy={busy || needsLibraryRefresh}
                                onOpen={openOfficial}
                                onEdit={editProgress}
                                onComplete={complete}
                              />
                            ))}
                          </section>
                        )}
                        {queue.caughtUp.length > 0 && (
                          <section className="caught-up-list">
                            <h2>已追平</h2>
                            {queue.caughtUp.map(({ series, follow }) => (
                              <button
                                key={series.id}
                                className="caught-up-item"
                                onClick={() => editProgress({ series, follow })}
                              >
                                <Check size={16} />
                                {series.title}
                                <small>{progressLabel(follow)}</small>
                              </button>
                            ))}
                          </section>
                        )}
                      </>
                    ) : (
                      <>
                        {!library?.follows.length ? (
                          <EmptyWorkspace
                            title="你的追番清单还是空的"
                            description="从国漫合集找到作品，或补录我们还没有收录的动漫。"
                            onBrowse={() => setView("catalog")}
                            onSubmit={openSubmission}
                          />
                        ) : (
                          <div className="library-list">
                            {library.follows.map((follow) => {
                              const series = library.series.find(
                                (x) => x.id === follow.seriesId,
                              );
                              if (!series) return null;
                              const latest = latestPublishedEpisode(
                                series,
                                now,
                              );
                              return (
                                <article
                                  className={`library-row ${isSupportedPlatform(series.platform) ? "" : "unsupported-platform"}`}
                                  key={series.id}
                                >
                                  <div className="library-thumb">
                                    {series.cover ? (
                                      <img
                                        src={series.cover}
                                        alt=""
                                        referrerPolicy="no-referrer"
                                        onError={(e) => {
                                          e.currentTarget.style.display =
                                            "none";
                                        }}
                                      />
                                    ) : (
                                      <ListVideo />
                                    )}
                                  </div>
                                  <div className="library-details">
                                    <h2>
                                      {series.title}
                                      {follow.paused && <small>已暂停</small>}
                                      {!isSupportedPlatform(series.platform) && <small>平台暂不可用</small>}
                                    </h2>
                                    <p>
                                      {platforms[series.platform]?.name} ·{" "}
                                      {progressLabel(follow)} ·{" "}
                                      {latest !== null
                                        ? `已核验至 ${latest} 集`
                                        : "最新集数待核验"}
                                    </p>
                                    <Verification
                                      series={series}
                                      stale={
                                        now -
                                          Date.parse(
                                            series.lastScanAt ||
                                              series.checkedAt,
                                          ) >
                                        2 * 86400000
                                      }
                                    />
                                  </div>
                                  <div className="library-actions">
                                    {isSupportedPlatform(series.platform) ? (
                                      <a
                                        className="secondary-action"
                                        href={series.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => openOfficial(series)}
                                      >
                                        官方播放
                                        <ExternalLink size={13} />
                                      </a>
                                    ) : (
                                      <button className="secondary-action" disabled title="暂不支持该平台">
                                        平台暂不可用
                                      </button>
                                    )}
                                    <button
                                      className="secondary-action"
                                      disabled={busy || needsLibraryRefresh || !isSupportedPlatform(series.platform)}
                                      onClick={() =>
                                        editProgress({ series, follow })
                                      }
                                    >
                                      修改进度
                                    </button>
                                    <button
                                      className="text-action"
                                      disabled={busy || needsLibraryRefresh}
                                      onClick={() =>
                                        void perform(
                                          "unfollow",
                                          { seriesId: series.id },
                                          "已移出追番，其他记录不受影响。",
                                        )
                                      }
                                    >
                                      取消追番
                                    </button>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
        <p className="workspace-footnote">
          播放在官方平台进行，会员与地区权限以平台为准。进度由你确认；手机链接是否唤起
          App 取决于平台支持。
        </p>
      </main>
      <footer>
        <Link className="footer-brand" href="/">
          国漫追更 <span>GUOMAN TRACKER</span>
        </Link>
        <span>聚合信息 · 官方观看 · 不存储音视频</span>
      </footer>
      {loginOpen && (
        <DialogFrame title="邮箱验证码登录" onClose={closeLogin} locked={sending || verifying} returnFocusRef={loginTrigger}>
          <p className="dialog-description">输入邮箱获取验证码。首次验证会建立账号；登录后读取该账号的云端追番记录。</p>
          <form onSubmit={(event) => { event.preventDefault(); void (pendingAccount || needsLibraryRetry ? retryLibrary() : challenge ? verifyCode() : sendCode()); }}>
            <label>邮箱地址
              <input type="email" autoComplete="email" required value={email} disabled={sending || verifying || pendingAccount || needsLibraryRetry}
                onChange={(event) => { setEmail(event.target.value); setChallenge(null); setToken(""); setLoginError(""); }} />
            </label>
            {challenge && !pendingAccount && !needsLibraryRetry && <label>邮件验证码
              <input inputMode="numeric" autoComplete="one-time-code" required value={token} disabled={sending || verifying}
                onChange={(event) => setToken(event.target.value)} />
            </label>}
            {loginError && <p role="alert" className="dialog-error">{loginError}</p>}
            {pendingAccount || needsLibraryRetry ? (
              <>
                <button type="submit" className="primary-action" disabled={sending || verifying}>重试确认账号并加载记录</button>
                <button type="button" className="text-action email-resend" disabled={sending || verifying} onClick={() => void switchAccount()}>退出此账号并换邮箱</button>
              </>
            ) : (
              <>
                <button type="submit" className="primary-action" disabled={sending || verifying || (challenge !== null && !token.trim()) || (challenge === null && cooldownNow < resendAt)}>
                  {sending ? "正在发送…" : verifying ? "正在验证…" : challenge ? "验证并登录" : cooldownNow < resendAt ? `请在 ${Math.ceil((resendAt - cooldownNow) / 1000)} 秒后发送` : "发送验证码"}
                </button>
                {challenge && <button type="button" className="text-action email-resend" disabled={sending || verifying || cooldownNow < resendAt}
                  onClick={() => void sendCode()}>
                  {cooldownNow < resendAt ? `请在 ${Math.ceil((resendAt - cooldownNow) / 1000)} 秒后重发` : "重新发送验证码"}
                </button>}
              </>
            )}
          </form>
        </DialogFrame>
      )}
      {submitOpen && (
        <SubmissionDialog
          busy={busy || needsLibraryRefresh}
          mode={mode}
          error={dialogError}
          onClose={() => setSubmitOpen(false)}
          onSubmit={async (url) => {
            const success = await perform(
              "submit",
              { url },
              "已补录并加入追番，等待官方元数据核验。",
            );
            if (success) {
              setSubmitOpen(false);
              setView("library");
            }
          }}
        />
      )}
      {editing && (
        <ProgressDialog
          series={editing.series}
          follow={editing.follow}
          busy={busy || needsLibraryRefresh}
          error={dialogError}
          onClose={() => setEditing(null)}
          onSave={async (values) => {
            if (
              await perform(
                "progress",
                {
                  seriesId: editing.series.id,
                  ...values,
                  version: editing.follow.version,
                },
                "观看进度已保存。",
              )
            )
              setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function progressLabel(follow: WatchState) {
  if (follow.currentEpisode === 0) return "还没开始";
  return `第 ${follow.currentEpisode} 集 · ${follow.episodeCompleted ? "已看完" : "未看完"}`;
}
function Verification({ series, stale }: { series: Anime; stale: boolean }) {
  const unverified =
    !!series.monitoring &&
    !series.lastScanAt &&
    latestPublishedEpisode(series) === null;
  return (
    <div className="verification">
      {series.monitoring && <span>{monitoringLabels[series.monitoring]}</span>}
      <span>
        {unverified
          ? "尚未完成官网核验"
          : `${stale ? "信息较旧 · " : ""}最近核验 ${new Date(series.lastScanAt || series.checkedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}`}
      </span>
      {series.lastScanAttemptAt && (
        <span>
          最近尝试{" "}
          {new Date(series.lastScanAttemptAt).toLocaleDateString("zh-CN", {
            timeZone: "Asia/Shanghai",
          })}
        </span>
      )}
      {series.scanError && <span>{series.scanError}</span>}
    </div>
  );
}
type PlaybackProps = {
  candidate: WatchCandidate;
  busy: boolean;
  onOpen: (series: Anime) => void;
  onEdit: (data: { series: Anime; follow: WatchState }) => void;
  onComplete: (series: Anime, follow: WatchState) => void;
};
function PlaybackActions({
  candidate,
  busy,
  onOpen,
  onEdit,
  onComplete,
}: PlaybackProps) {
  return (
    <div className="action-row">
      {isSupportedPlatform(candidate.series.platform) ? <a
        className="primary-action"
        href={candidate.series.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => onOpen(candidate.series)}
      >
        <Play size={15} fill="currentColor" />
        前往官方
        {candidate.follow.currentEpisode > 0 &&
        !candidate.follow.episodeCompleted
          ? "续看"
          : "观看"}
        <ExternalLink size={14} />
      </a> : <button className="primary-action" disabled>平台暂不可用</button>}
      {candidate.unwatched > 0 && (
        <button
          className="secondary-action"
          disabled={busy || !isSupportedPlatform(candidate.series.platform)}
          onClick={() => onComplete(candidate.series, candidate.follow)}
        >
          <Check size={15} />
          看完第 {candidate.nextEpisode} 集
        </button>
      )}
      <button
        className="text-action"
        disabled={busy || !isSupportedPlatform(candidate.series.platform)}
        onClick={() =>
          onEdit({ series: candidate.series, follow: candidate.follow })
        }
      >
        修改进度
      </button>
    </div>
  );
}
function WatchCard(props: PlaybackProps) {
  const { candidate } = props;
  return (
    <article className="watch-card">
      <div className="watch-card-heading">
        <span className="small-label">
          {platforms[candidate.series.platform]?.name}
        </span>
        <span>
          {candidate.latestEpisode === null
            ? "待核验"
            : `${candidate.unwatched} 集未看`}
        </span>
      </div>
      <h3>{candidate.series.title}</h3>
      <p>
        {progressLabel(candidate.follow)}
        {candidate.latestEpisode !== null &&
          ` · 最新 ${candidate.latestEpisode} 集`}
      </p>
      <PlaybackActions {...props} />
      <Verification series={candidate.series} stale={candidate.stale} />
    </article>
  );
}
function EmptyWorkspace({
  title,
  description,
  onBrowse,
  onSubmit,
}: {
  title: string;
  description: string;
  onBrowse: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="workspace-empty">
      <Bookmark size={30} />
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="action-row">
        <button className="primary-action" onClick={onBrowse}>
          浏览国漫合集
        </button>
        <button className="secondary-action" onClick={onSubmit}>
          补录动漫
        </button>
      </div>
    </section>
  );
}

function DialogFrame({
  title,
  onClose,
  locked = false,
  returnFocusRef,
  children,
}: {
  title: string;
  onClose: () => void;
  locked?: boolean;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focusRef = returnFocusRef;
    dialog.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      if (focusRef?.current?.isConnected) focusRef.current.focus();
    };
  }, [returnFocusRef]);
  return (
    <dialog
      ref={dialog}
      className="modal-backdrop"
      aria-labelledby="modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
        ) || []);
        if (!elements.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }}
    >
      <section className="workspace-dialog">
        <div className="dialog-heading">
          <h2 id="modal-title">{title}</h2>
          <button aria-label="关闭窗口" onClick={onClose} disabled={locked}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </dialog>
  );
}
function SubmissionDialog({
  mode,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  mode: Mode;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  return (
    <DialogFrame title="补录想追的动漫" onClose={onClose}>
      <p className="dialog-description">
        合集里还没有？提交官方链接后会加入待核验清单。这里只上传节目信息，不上传视频文件。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(url);
        }}
      >
        <label>
          官方播放或详情链接
          <input
            autoFocus
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.bilibili.com/bangumi/play/ss…"
          />
        </label>
        <p className="field-note">
          支持哔哩哔哩、腾讯视频和优酷。请先打开官网复制完整链接，暂不支持短链和搜索页。
        </p>
        {mode === "guest" && (
          <p className="field-note">请先登录后提交。</p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button
          className="primary-action"
          type="submit"
          disabled={busy || mode === "guest"}
        >
          {busy ? "正在提交…" : "补录并追番"}
        </button>
      </form>
    </DialogFrame>
  );
}
function ProgressDialog({
  series,
  follow,
  busy,
  error,
  onClose,
  onSave,
}: {
  series: Anime;
  follow: WatchState;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (values: {
    currentEpisode: number;
    episodeCompleted: boolean;
    paused: boolean;
  }) => Promise<void>;
}) {
  const [episode, setEpisode] = useState(String(follow.currentEpisode));
  const [completed, setCompleted] = useState(follow.episodeCompleted);
  const [paused, setPaused] = useState(follow.paused);
  const latest = latestPublishedEpisode(series);
  const maximum = latest ?? 10000;
  const numericEpisode = Number(episode);
  const validEpisode =
    episode.trim() !== "" &&
    Number.isInteger(numericEpisode) &&
    numericEpisode >= 0 &&
    numericEpisode <= maximum;
  function changeEpisode(value: string) {
    setEpisode(value);
    if (Number(value) === 0) setCompleted(false);
  }
  return (
    <DialogFrame title="更新观看进度" onClose={onClose}>
      <p className="dialog-description">{series.title}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({
            currentEpisode: numericEpisode,
            episodeCompleted: completed,
            paused,
          });
        }}
      >
        <label htmlFor="progress-episode">看到第几集</label>
        <div className="episode-stepper">
          <button
            type="button"
            aria-label="减少一集"
            disabled={busy || !validEpisode || numericEpisode <= 0}
            onClick={() => changeEpisode(String(numericEpisode - 1))}
          >
            <Minus size={26} strokeWidth={2.4} aria-hidden="true" />
          </button>
          <input
            id="progress-episode"
            autoFocus
            type="number"
            inputMode="numeric"
            required
            min={0}
            max={maximum}
            step={1}
            value={episode}
            disabled={busy}
            onChange={(e) => changeEpisode(e.target.value)}
          />
          <button
            type="button"
            aria-label="增加一集"
            disabled={busy || !validEpisode || numericEpisode >= maximum}
            onClick={() => changeEpisode(String(numericEpisode + 1))}
          >
            <Plus size={26} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
        <p className="field-note">
          0 表示还没开始，每次加减一集。
          {latest !== null
            ? `官网最近核验至第 ${latest} 集。`
            : "最新集数待核验，可先记录自己的进度。"}
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={completed}
            disabled={busy || !validEpisode || numericEpisode === 0}
            onChange={(e) => setCompleted(e.target.checked)}
          />
          这一集已看完
        </label>
        <p className="field-note">未勾选时推荐继续这一集，勾选后推荐下一集。</p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
          />
          <Pause size={14} />
          暂停追番（暂时不参与观看推荐）
        </label>
        <p className="field-note">
          官方平台暂未同步观看记录；集数与是否看完由你确认。
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary-action" disabled={busy}>
          {busy ? "保存中…" : "保存观看进度"}
        </button>
      </form>
    </DialogFrame>
  );
}
