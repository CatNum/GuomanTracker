"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  ExternalLink,
  ListVideo,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import Catalog from "./catalog";
import { platforms, type Anime } from "@/lib/catalog";
import {
  watchingQueue,
  latestPublishedEpisode,
  type Library,
  type WatchState,
  type WatchCandidate,
} from "@/lib/watching";
import { createLocalLibrary } from "@/lib/local-library";
import {
  beginWechatLogin,
  cloudApp,
  cloudCall,
  cloudConfigured,
} from "@/lib/cloudbase-client";
import { endCloudSession, followCatalogSeries } from "@/lib/account-actions";

type Mode = "guest" | "demo" | "cloud";
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
  const [now, setNow] = useState(Date.parse(checkedAt));
  const call = useCallback(
    async (
      action: string,
      payload: Record<string, unknown> = {},
      selectedMode = mode,
    ) =>
      selectedMode === "demo"
        ? createLocalLibrary(localStorage, initial).call(action, payload)
        : cloudCall(action, payload),
    [mode, initial],
  );
  const reload = useCallback(
    async (selectedMode: Mode = mode) => {
      if (selectedMode === "guest") return;
      setLibrary((await call("library", {}, selectedMode)) as Library);
    },
    [call, mode],
  );
  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        let selected: Mode = "guest";
        if (
          cloudConfigured &&
          (await (await cloudApp()).auth().getLoginState())
        )
          selected = "cloud";
        else if (localStorage.getItem("guoman-demo-enabled") === "yes")
          selected = "demo";
        if (active) {
          setMode(selected);
          if (selected !== "guest") {
            const data = (await call("library", {}, selected)) as Library;
            if (active) setLibrary(data);
          }
        }
      } catch (error) {
        if (active) setNotice("账号数据加载未完成：" + errorText(error));
      } finally {
        if (active) setLoading(false);
      }
    }
    void initialize();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // 首次挂载恢复明确选择的账号或本机演示。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const queue = useMemo(
    () => watchingQueue(library?.series || [], library?.follows || [], now),
    [library, now],
  );
  const followed = library?.follows.map((x) => x.seriesId) || [];
  const activeCount = library?.follows.filter((x) => !x.paused).length || 0;

  async function perform(
    action: string,
    payload: Record<string, unknown>,
    message: string,
  ) {
    if (mode === "guest") {
      setNotice("请先微信登录，或选择本机演示后再保存追番。");
      return false;
    }
    setBusy(true);
    setNotice("");
    setDialogError("");
    try {
      await call(action, payload);
      await reload();
      setNotice(message);
      return true;
    } catch (error) {
      setNotice(errorText(error));
      setDialogError(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function startDemo() {
    setBusy(true);
    try {
      localStorage.setItem("guoman-demo-enabled", "yes");
      setMode("demo");
      await reload("demo");
      setNotice(
        "已进入本机演示。记录只保存在当前浏览器，补录不会实际触发云端扫描。",
      );
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function login() {
    setBusy(true);
    try {
      await beginWechatLogin();
    } catch (error) {
      setNotice(errorText(error));
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      const clear = () => {
        localStorage.removeItem("guoman-demo-enabled");
        setMode("guest");
        setLibrary(null);
        setNotice("已退出当前账号。");
      };
      if (mode === "cloud")
        await endCloudSession((await cloudApp()).auth(), clear);
      else clear();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  function openOfficial(series: Anime) {
    if (mode !== "guest")
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
    setDialogError("");
    setEditing(data);
  }
  async function complete(series: Anime, follow: WatchState) {
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
        <a className="brand" href="/">
          <span className="brand-icon">
            <Play size={19} fill="currentColor" />
          </span>
          <b>
            国漫<span>追更</span>
          </b>
          <span className="brand-en">GUOMAN TRACKER</span>
        </a>
        <div className="account-menu">
          {mode === "guest" ? (
            <button
              className="secondary-action"
              onClick={login}
              disabled={busy || loading}
            >
              微信登录
            </button>
          ) : (
            <>
              <span>
                {mode === "demo"
                  ? "本机演示"
                  : library?.user.displayName || "我的账号"}
              </span>
              <button className="text-action" disabled={busy} onClick={logout}>
                {mode === "demo" ? "退出演示" : "退出"}
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
        {mode === "demo" && (
          <div className="demo-banner">
            本机演示 · 未微信登录 · 数据仅保存在当前浏览器 · 不执行云端扫描
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            <span>{notice}</span>
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              <X size={16} />
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
                  if (!busy)
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
                      onClick={() => {
                        setBusy(true);
                        void reload()
                          .then(() =>
                            setNotice(
                              "观看记录已刷新；更新时间以最近官网核验为准。",
                            ),
                          )
                          .catch((e) => setNotice(errorText(e)))
                          .finally(() => setBusy(false));
                      }}
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
                          onClick={login}
                          disabled={busy}
                        >
                          微信登录并保存进度
                        </button>
                        <button
                          className="secondary-action"
                          onClick={startDemo}
                          disabled={busy}
                        >
                          体验本机演示
                        </button>
                      </div>
                      <small>
                        {cloudConfigured
                          ? "登录后记录会随微信账号保存。"
                          : "微信登录等待上线配置，当前可以先浏览合集或体验本机演示。"}
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
                                  busy={busy}
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
                                  busy={busy}
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
                                busy={busy}
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
                                  className="library-row"
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
                                    <button
                                      className="secondary-action"
                                      disabled={busy}
                                      onClick={() =>
                                        editProgress({ series, follow })
                                      }
                                    >
                                      修改进度
                                    </button>
                                    <button
                                      className="text-action"
                                      disabled={busy}
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
        <a className="footer-brand" href="/">
          国漫追更 <span>GUOMAN TRACKER</span>
        </a>
        <span>聚合信息 · 官方观看 · 不存储音视频</span>
      </footer>
      {submitOpen && (
        <SubmissionDialog
          busy={busy}
          mode={mode}
          error={dialogError}
          onClose={() => setSubmitOpen(false)}
          onSubmit={async (title, url) => {
            const success = await perform(
              "submit",
              { title, url },
              mode === "demo"
                ? "已在本机演示中补录并追番；上线配置后才会实际监控。"
                : "已补录并加入追番，等待官方元数据核验。",
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
          busy={busy}
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
      <a
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
      </a>
      {candidate.unwatched > 0 && (
        <button
          className="secondary-action"
          disabled={busy}
          onClick={() => onComplete(candidate.series, candidate.follow)}
        >
          <Check size={15} />
          看完第 {candidate.nextEpisode} 集
        </button>
      )}
      <button
        className="text-action"
        disabled={busy}
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
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
    };
  }, []);
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
    >
      <section className="workspace-dialog">
        <div className="dialog-heading">
          <h2 id="modal-title">{title}</h2>
          <button aria-label="关闭窗口" onClick={onClose}>
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
  onSubmit: (title: string, url: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(""),
    [url, setUrl] = useState("");
  return (
    <DialogFrame title="补录想追的动漫" onClose={onClose}>
      <p className="dialog-description">
        合集里还没有？提交名称和官方链接，我们会将它加入核验清单。这里只上传节目信息，不上传视频文件。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(title, url);
        }}
      >
        <label>
          动漫名称
          <input
            autoFocus
            required
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：你想追的国漫"
          />
        </label>
        <label>
          官方播放或详情链接
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.bilibili.com/bangumi/play/ss…"
          />
        </label>
        <p className="field-note">
          支持哔哩哔哩、腾讯视频、优酷、爱奇艺、芒果TV。请先打开官网复制完整链接，暂不支持短链和搜索页。
        </p>
        {mode === "guest" && (
          <p className="field-note">请先登录或体验本机演示后提交。</p>
        )}
        {mode === "demo" && (
          <p className="field-note">演示仅保存本机记录，不会启动实际扫描。</p>
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
            −
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
            +
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
