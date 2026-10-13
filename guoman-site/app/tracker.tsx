"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Bookmark,
  CalendarDays,
  ChevronRight,
  Layers3,
  UserRound,
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
import RecommendationDeck from "@/components/recommendation-deck";
import { OperationButton } from "@/components/operation-button";
import { AnimeCollection, AnimeEntry, AnimeDisplayToggle } from "@/components/anime-collection";
import { useAnimeDisplayMode } from "@/hooks/use-anime-display-mode";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { isSupportedPlatform, platforms, type Anime } from "@/lib/catalog";
import {
  watchingQueue,
  latestPublishedEpisode,
  filterFollowIds,
  orderedRecommendations,
  sortFollowIds,
  type Library,
  type WatchState,
  type WatchCandidate,
  type WatchFilter,
  type FollowSort,
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
import { applyConfirmedMembership, applyConfirmedReorder, isDefinitiveBusinessRejection, runLibraryOperation } from "@/lib/library-operation";
import { libraryBelongsToUser, readVerifiedLibrary } from "@/lib/library-identity";

import { clearLibrarySnapshot, readLibrarySnapshot, saveLibrarySnapshot } from "@/lib/library-snapshot";
import { openEpisodePlayback } from "@/lib/episode-playback";

const snapshotStorage = {
  getItem: (key: string) => window.sessionStorage.getItem(key),
  setItem: (key: string, value: string) => window.sessionStorage.setItem(key, value),
  removeItem: (key: string) => window.sessionStorage.removeItem(key),
};
type Mode = "guest" | "cloud";
type View = "draw" | "calendar" | "library" | "catalog";
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
    [view, setView] = useState<View>("draw");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [catalogItems, setCatalogItems] = useState(initial);
  const [statsHelpOpen, setStatsHelpOpen] = useState(false);
  const [listFilter, setListFilter] = useState<WatchFilter>("all");
  const [listSort, setListSort] = useState<FollowSort>("priority");
  const [displayMode, setDisplayMode] = useAnimeDisplayMode("list");
  const [saving, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [submitOpen, setSubmitOpen] = useState(false),
    [editing, setEditing] = useState<{
      series: Anime;
      follow: WatchState;
    } | null>(null);
  const busy = saving || loading;
  const [jumping, setJumping] = useState<{ series: Anime; episode: number } | null>(null);
  const [pendingMutation, setPendingMutation] = useState<{ action: string; seriesId: string } | null>(null);
  const [pendingCatalogFollowId, setPendingCatalogFollowId] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [needsLibraryRefresh, setNeedsLibraryRefresh] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false),
    [accountEmail, setAccountEmail] = useState(""),
    [catalogAccountKey, setCatalogAccountKey] = useState(""),
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
  const accountUserId = useRef<string | null>(null);
  const modeRef = useRef<Mode>("guest");
  const mounted = useRef(true);
  const loginTrigger = useRef<HTMLButtonElement | null>(null);
  const draggedSeriesId = useRef<string | null>(null);
  const noticeId = useRef<string | number | undefined>(undefined);
  function showNotice(message: string, duration = Infinity) {
    if (noticeId.current !== undefined) toast.dismiss(noticeId.current);
    // A fresh ID prevents an earlier toast's exit animation from removing its replacement.
    noticeId.current = message ? toast(message, { duration }) : undefined;
  }
  useEffect(() => {
    if (!statsHelpOpen) return;
    function closeStatsHelp(event: KeyboardEvent) {
      if (event.key === "Escape") setStatsHelpOpen(false);
    }
    document.addEventListener("keydown", closeStatsHelp);
    return () => document.removeEventListener("keydown", closeStatsHelp);
  }, [statsHelpOpen]);
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
    (action: string, payload: Record<string, unknown> = {}, expectedUserId?: string) => cloudCall(action, payload, expectedUserId),
    [],
  );
  const reload = useCallback(
    async () => {
      if (modeRef.current === "guest") return null;
      const currentGeneration = generation.current;
      const current = () => mounted.current && currentGeneration === generation.current && modeRef.current === "cloud";
      const verified = await readVerifiedLibrary(
        getAuthenticatedSession,
        async (expectedUserId) => await call("library", {}, expectedUserId) as Library,
        current,
      );
      if (!verified || !current()) return null;
      accountUserId.current = verified.session.userId;
      setCatalogAccountKey(verified.session.userId);
      setAccountEmail(verified.session.email || "");
      setLibrary(verified.library);
      return verified.library;
    },
    [call],
  );
  useEffect(() => {
    let active = true;
    const generationRef = generation;
    mounted.current = true;
    async function initialize() {
      const currentGeneration = generation.current;
      let restored = false;
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
        if (checked?.session) {
          accountUserId.current = checked.session.userId;
          modeRef.current = "cloud";
          setMode("cloud");
          setAccountEmail(verifiedAccountEmail);
          setCatalogAccountKey(checked.session.userId);
          const cached = readLibrarySnapshot(snapshotStorage, checked.session.userId);
          if (cached) { restored = true; setLibrary(cached); }
        }
        const data = selected === "guest" ? null : (await call("library", {}, checked?.session?.userId)) as Library;
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
            setLibrary(null);
            throw new CloudActionError("账号会话已变化，未加载其他账号记录，请重新加载当前账号记录。", "ACCOUNT_CHANGED");
          }
        }
        if (active && currentGeneration === generation.current) {
          setAccountEmail(verifiedAccountEmail);
          accountUserId.current = selected === "cloud" ? checked?.session?.userId || null : null;
          setCatalogAccountKey(selected === "cloud" ? checked?.session?.userId || "" : "");
          modeRef.current = selected;
          setMode(selected);
          setLibrary(data);
          if (sessionUncertain) {
            setPendingAccount(true);
            showNotice("账号状态暂未确认，可继续加载或退出账号：" + errorText(sessionError));
          }
        }
      } catch (error) {
        if (active && currentGeneration === generation.current) {
          showNotice("账号数据加载未完成：" + errorText(error));
          if (error instanceof CloudActionError && ["ACCOUNT_CHANGED", "UNAUTHENTICATED"].includes(error.code || "")) {
            if (accountUserId.current) clearLibrarySnapshot(snapshotStorage, accountUserId.current);
            accountUserId.current = null;
            setLibrary(null);
            setAccountEmail("");
            setCatalogAccountKey("");
            modeRef.current = "guest";
            setMode("guest");
            setPendingAccount(error.code === "ACCOUNT_CHANGED");
            setNeedsLibraryRetry(false);
            setLoginError(errorText(error));
          } else if (authenticated || sessionUncertain) {
            markLibraryRefresh(true);
            setPendingAccount(true);
            if (authenticated) {
              setNeedsLibraryRetry(true);
              if (!restored) setLoginOpen(true);
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
      if (noticeId.current !== undefined) toast.dismiss(noticeId.current);
      clearInterval(timer);
      clearTimeout(initialNow);
    };
    // 首次挂载恢复可信 SDK 账号会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!loading && !needsLibraryRefresh && library && accountUserId.current === library.user.uid && mode === "cloud")
      saveLibrarySnapshot(snapshotStorage, library);
  }, [library, loading, needsLibraryRefresh, mode]);
  const queue = useMemo(
    () => watchingQueue(library?.series || [], library?.follows || [], now),
    [library, now],
  );
  const followed = library?.follows.map((x) => x.seriesId) || [];
  const fullPriorityOrder = useMemo(
    () => sortFollowIds(library?.follows || [], library?.series || [], library?.priorityOrder || [], "priority"),
    [library],
  );
  const recommendations = orderedRecommendations(queue.ready, fullPriorityOrder);
  const visibleFollowIds = useMemo(() => {
    if (!library) return [];
    const visible = new Set(filterFollowIds(library.follows, queue, listFilter, queue.thisWeek.map((candidate) => candidate.series.id)));
    return sortFollowIds(library.follows, library.series, fullPriorityOrder, listSort).filter((id) => visible.has(id));
  }, [fullPriorityOrder, library, listFilter, listSort, queue]);
  const weekCount = queue.thisWeek.length;
  const activeCount = library?.follows.filter((follow) => !follow.paused).length || 0;
  const reorderAllowed = listFilter === "all" && listSort === "priority" && !needsLibraryRefresh;

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
    setPendingMutation({ action: "library", seriesId: "" });
    try {
      const data = await reload();
      if (!data || !current()) return;
      if (needsLibraryRefreshRef.current) {
        markLibraryRefresh(false);
        setEditing(null);
        setJumping(null);
        setSubmitOpen(false);
      }
      setPendingAccount(false);
      setNeedsLibraryRetry(false);
      showNotice("观看记录已刷新；更新时间以最近官网核验为准。", 4000);
      setDialogError("");
    } catch (error) {
      if (current()) showNotice("记录重新加载未完成，请稍后重试。" + errorText(error));
    } finally {
      mutationLock.current = false;
      if (current()) { setBusy(false); setPendingMutation(null); }
    }
  }

  async function perform(
    action: string,
    payload: Record<string, unknown>,
    message: string | ((writeResult: unknown) => string),
    confirmedResult?: (writeResult: unknown) => Library | null,
    confirmedUserId?: string,
  ) {
    const selectedMode = modeRef.current;
    if (selectedMode === "guest") {
      showNotice("请先邮箱登录，再保存追番。");
      return false;
    }
    if (needsLibraryRefreshRef.current) {
      showNotice("请先重新加载记录，再继续保存。");
      return false;
    }
    if (loading || mutationLock.current) return false;
    mutationLock.current = true;
    const currentGeneration = generation.current;
    const current = () => mounted.current && generation.current === currentGeneration && modeRef.current === selectedMode;
    setBusy(true);
    setPendingMutation({ action, seriesId: typeof payload.seriesId === "string" ? payload.seriesId : "" });
    showNotice("");
    setDialogError("");
    try {
      const baseline = library;
      const confirmedOwner = confirmedUserId || baseline?.user.uid;
      const applyResult = confirmedResult || (baseline && (action === "follow" || action === "unfollow") && typeof payload.seriesId === "string"
        ? (value: unknown) => applyConfirmedMembership(baseline, action, payload.seriesId as string, value) : undefined);
      let writeResult: unknown;
      const result = await runLibraryOperation(
        async () => {
          const expectedUserId = accountUserId.current;
          if (!expectedUserId) throw new CloudActionError("账号会话已变化，请刷新并确认当前账号。", "ACCOUNT_CHANGED");
          writeResult = await call(action, payload, expectedUserId);
          return writeResult;
        },
        async () => {
          if (!current()) throw new Error("账号已切换");
          const data = await reload();
          if (!data) throw new Error("账号已切换");
          return data;
        },
        isDefinitiveBusinessRejection,
        applyResult && (async (result) => {
          const session = await getAuthenticatedSession();
          if (!current() || !session || session.userId !== accountUserId.current || session.userId !== confirmedOwner)
            throw new CloudActionError("账号会话已变化，请刷新并确认当前账号。", "ACCOUNT_CHANGED");
          return applyResult(result);
        }),
      );
      if (!current()) return false;
      if (result.kind === "saved") {
        setLibrary(result.library);
        markLibraryRefresh(false);
        showNotice(typeof message === "function" ? message(writeResult) : message, 4000);
        return true;
      }
      if (result.kind === "saved-unrefreshed") {
        markLibraryRefresh(true);
        showNotice("已保存，展示待刷新。请重新加载记录后继续操作。");
        return true;
      }
      if (result.kind === "unknown" || (result.error instanceof CloudActionError && result.error.code === "CONFLICT")) {
        markLibraryRefresh(true);
        const text = result.kind === "unknown"
          ? "提交结果暂未确认，请先重新加载记录。"
          : "记录版本已变化，请先重新加载记录。";
        showNotice(text);
        setDialogError(text);
        return false;
      }
      showNotice(errorText(result.error));
      setDialogError(errorText(result.error));
      return false;
    } finally {
      mutationLock.current = false;
      if (current()) { setBusy(false); setPendingMutation(null); }
    }
  }
  async function movePriority(seriesId: string, direction: -1 | 1) {
    if (!library || listFilter !== "all" || listSort !== "priority" || busy || needsLibraryRefreshRef.current) return;
    const index = fullPriorityOrder.indexOf(seriesId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= fullPriorityOrder.length) return;
    const next = [...fullPriorityOrder];
    [next[index], next[target]] = [next[target], next[index]];
    await perform("reorder", {
      seriesIds: next,
      expectedMembershipVersion: library.membershipVersion ?? 0,
      expectedOrderVersion: library.orderVersion ?? 0,
    }, "", (writeResult) => applyConfirmedReorder(library, next, writeResult), library.user.uid);
  }
  async function movePriorityBefore(sourceId: string, targetId: string) {
    if (!library || sourceId === targetId || listFilter !== "all" || listSort !== "priority" || busy || needsLibraryRefreshRef.current) return;
    const next = [...fullPriorityOrder];
    const source = next.indexOf(sourceId);
    const target = next.indexOf(targetId);
    if (source < 0 || target < 0) return;
    next.splice(source, 1);
    next.splice(target, 0, sourceId);
    await perform("reorder", {
      seriesIds: next,
      expectedMembershipVersion: library.membershipVersion ?? 0,
      expectedOrderVersion: library.orderVersion ?? 0,
    }, "", (writeResult) => applyConfirmedReorder(library, next, writeResult), library.user.uid);
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
    const current = () => mounted.current && currentGeneration === generation.current;
    const verified = await readVerifiedLibrary(
      getAuthenticatedSession,
      async (expectedUserId) => await cloudCall("library", {}, expectedUserId) as Library,
      current,
    );
    if (!verified || !current()) return;
    const { library: data, session } = verified;
    setAccountEmail(session.email || "");
    accountUserId.current = session.userId;
    setCatalogAccountKey(session.userId);
    generation.current++;
    markLibraryRefresh(false);
    modeRef.current = "cloud";
    setMode("cloud");
    setLibrary(data);
    setBusy(false);
    setPendingAccount(false);
    setNeedsLibraryRetry(false);
    setEditing(null);
    setJumping(null);
    setSubmitOpen(false);
    setLoginOpen(false);
    setChallenge(null);
    setToken("");
    showNotice("邮箱账号已登录，云端追番记录已加载。", 4000);
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
        if (accountUserId.current) clearLibrarySnapshot(snapshotStorage, accountUserId.current);
        accountUserId.current = null;
        setJumping(null);
        setCatalogAccountKey("");
        modeRef.current = "guest";
        setMode("guest");
        setLibrary(null);
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
        if (accountUserId.current) clearLibrarySnapshot(snapshotStorage, accountUserId.current);
        accountUserId.current = null;
        setJumping(null);
        setCatalogAccountKey("");
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
        showNotice("已退出当前账号。", 4000);
      };
      if (mode === "cloud" || pendingAccount || needsLibraryRetry)
        await endCloudSession((await cloudApp()).auth(), clear);
      else clear();
    } catch (error) {
      showNotice(errorText(error));
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
      <main className={`tracker-workspace ${sidebarExpanded ? "sidebar-expanded" : "sidebar-collapsed"}`}>
        <aside className="tracker-sidebar">
        <div className="sidebar-panel">
        <div className="sidebar-brand-row">
          <Link className="sidebar-brand" href="/" aria-label="国漫追番首页"><Layers3 size={22}/><span>国漫追番<small>GUOMAN TRACKER</small></span></Link>
          <button className="sidebar-toggle" type="button" aria-expanded={sidebarExpanded} aria-controls="tracker-navigation" aria-label={sidebarExpanded ? "收起导航" : "展开导航"} title={sidebarExpanded ? "收起导航" : "展开导航"} onClick={() => setSidebarExpanded((expanded) => !expanded)}><ChevronRight size={15}/></button>
        </div>
        <nav className="tracker-nav" id="tracker-navigation" aria-label="主导航">
          {(
            [
              ["draw", "精准抽卡", Layers3],
              ["calendar", "新番周历", CalendarDays],
              ["library", "我的追番", Bookmark],
              ["catalog", "国漫合集", Search],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-current={view === key ? "page" : undefined}
              aria-label={label}
              title={label}
              className={view === key ? "active" : ""}
              onClick={() => {
                setView(key);
                if (window.matchMedia("(max-width: 700px)").matches) setSidebarExpanded(false);
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
          <button type="button" className="submit-entry" aria-label="国漫补录" title="国漫补录" onClick={() => {
            openSubmission();
            if (window.matchMedia("(max-width: 700px)").matches) setSidebarExpanded(false);
          }}>
            <Plus size={17} />
            <span>国漫补录</span>
          </button>
        </nav>
        <div className="sidebar-account">
          <OperationButton type="button" className="account-avatar" aria-label={mode === "guest" ? "邮箱登录" : "查看账号"} title={accountEmail || "邮箱登录"} busy={busy} onClick={(event) => { if (mode === "guest") openLogin(event); else setSidebarExpanded((expanded) => !expanded); }}><UserRound size={19}/><i className={mode === "cloud" ? "connected" : ""}/></OperationButton>
          <div className="account-menu">
          {mode === "guest" ? (
            <>
              {pendingAccount && <span>账号连接待恢复</span>}
              <OperationButton className="secondary-action" onClick={openLogin} busy={busy}>
                {pendingAccount ? "继续加载" : "邮箱登录"}
              </OperationButton>
              {pendingAccount && <OperationButton className="text-action" onClick={logout} busy={busy}>退出账号</OperationButton>}
            </>
          ) : (
            <>
              <span className="account-email">
                {accountEmail || library?.user.displayName || "我的账号"}
              </span>
              <OperationButton className="text-action" busy={busy} onClick={logout}>
                退出
              </OperationButton>
            </>
          )}
        </div>
        </div>
        </div>
        </aside>
        <div className={`tracker-content view-${view}`}>
        {loading && <div className="sync-status" role="status"><RefreshCw size={14} />正在同步云端记录{library ? "，已显示上次记录" : ""}…</div>}
        {loading && !library && view !== "catalog" ? (
          <section className="records-skeleton" aria-label="正在加载追番记录" aria-busy="true">
            <div className="skeleton-heading" />
            <div className="skeleton-cards">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton-card" />)}</div>
          </section>
        ) : (
          <>
            {view === "catalog" || view === "calendar" ? (
              <Catalog
                key={view}
                presentation={view === "calendar" ? "calendar" : "catalog"}
                initial={catalogItems}
                onCatalogSync={setCatalogItems}
                personalSeries={library?.series || []}
                checkedAt={checkedAt}
                embedded
                followed={followed}
                followBusy={busy}
                followBlocked={needsLibraryRefresh}
                pendingFollowId={pendingCatalogFollowId}
                accountReady={mode === "cloud"}
                accountKey={catalogAccountKey}
                onLogin={() => setLoginOpen(true)}
                onFollow={async (series) => {
                  if (busy || needsLibraryRefreshRef.current || mutationLock.current) return;
                  setPendingCatalogFollowId(series.id);
                  try {
                    await followCatalogSeries(
                      series,
                      [...initial, ...(library?.series || [])],
                      (action, payload) => perform(action, payload, `已追番《${series.title}》，可以设置观看进度。`),
                    );
                  } catch (error) { showNotice(errorText(error)); }
                  finally { setPendingCatalogFollowId(""); }
                }}
              />
            ) : (
              <>
                <div className="workspace-title" hidden={view === "draw"}>
                  <div>
                    <div className="eyebrow">
                      <span />
                      {view === "draw" ? "从未看的故事里，挑一部继续" : "你的故事进度"}
                    </div>
                    <h1>{view === "draw" ? "要看什么" : "我的追番"}</h1>
                    <p>{view === "draw" ? "选中一张卡牌，再次点击抽取详情。" : "记住看到哪里，下次接着看。"}</p>
                  </div>
                  {mode !== "guest" && (
                    <OperationButton
                      className="sync-button"
                      busy={busy}
                      aria-busy={pendingMutation?.action === "library"}
                      onClick={() => void refreshLibrary()}
                    >
                      <RefreshCw size={14} />
                      {pendingMutation?.action === "library" ? "刷新中…" : "刷新记录"}
                    </OperationButton>
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
                    {view === "draw" && (recommendations.length ? (
                      <RecommendationDeck
                        key={library?.user.uid || "no-account"}
                        candidates={recommendations}
                        renderDetails={(candidate, onEditProgress) => (
                          <div className="featured-body">
                            <span className="small-label">
                              {!candidate.follow.episodeCompleted && candidate.follow.currentEpisode > 0
                                ? "接着上次的故事"
                                : "有未看内容"}
                            </span>
                            <h2>{candidate.series.title}</h2>
                            <p>{progressLabel(candidate.follow)} · 已核验至第 {candidate.latestEpisode} 集</p>
                            <div className="next-episode">
                              从第 <b>{candidate.nextEpisode}</b> 集继续
                              <span>还有 {candidate.unwatched} 集未看</span>
                            </div>
                            <PlaybackActions
                              candidate={candidate}
                              busy={busy}
                              blocked={needsLibraryRefresh}
                              onOpen={openOfficial}
                              onJump={(series, episode) => onEditProgress(() => setJumping({ series, episode }))}
                              onEdit={(data) => onEditProgress(() => editProgress(data))}
                              onComplete={complete}
                            />
                            <Verification series={candidate.series} stale={candidate.stale} />
                          </div>
                        )}
                      />
                    ) : (
                      <div className="recommendation-empty" role="status">
                        <h2>{library?.follows.length ? "暂时没有可推荐的未看更新" : "先加入几部想追的国漫"}</h2>
                        <p>{library?.follows.length ? "待核验作品仍会列在追番清单中；可靠更新到来后会自动出现在这里。" : "从国漫合集加入追番，或补录官方节目链接。"}</p>
                        {!library?.follows.length && <button className="secondary-action" onClick={() => setView("catalog")}>浏览国漫合集</button>}
                      </div>
                    ))}
                    {view === "library" && <>
                    <div className="watch-stats-wrap">
                      <div className="watch-stats-help" onMouseEnter={() => setStatsHelpOpen(true)} onMouseLeave={() => setStatsHelpOpen(false)}>
                        <button type="button" aria-label="追番统计说明" aria-describedby="watch-stats-tooltip" aria-expanded={statsHelpOpen} onFocus={() => setStatsHelpOpen(true)} onBlur={() => setStatsHelpOpen(false)}>?</button>
                        <span className={`watch-stats-tooltip ${statsHelpOpen ? "visible" : ""}`} id="watch-stats-tooltip" role="tooltip">点击可以筛选对应内容</span>
                      </div>
                      <div className="watch-stats" aria-label="追番统计与筛选">
                        {([
                          ["week", weekCount, "本周更新未看"],
                          ["unwatched", queue.ready.length, "有未看内容"],
                          ["active", activeCount, "正在追番"],
                          ["caught-up", queue.caughtUp.length, "已追平"],
                        ] as const).map(([key, count, label]) => (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={listFilter === key}
                            className={listFilter === key ? "selected" : ""}
                            onClick={() => setListFilter(listFilter === key ? "all" : key)}
                          >
                            <strong>{count}</strong>
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <section className="library-section" aria-labelledby="follow-list-title">
                      <div className="section-heading library-section-heading">
                        <h2 id="follow-list-title">我的追番</h2>
                        <span>{library?.follows.length || 0} 部</span>
                      </div>
                      <div className="library-toolbar">
                        <AnimeDisplayToggle mode={displayMode} onChange={setDisplayMode} />
                        <div className="sort-controls" aria-label="追番列表排序">
                          <button type="button" aria-pressed={listSort === "priority"} className={listSort === "priority" ? "selected" : ""} onClick={() => setListSort("priority")}>优先级</button>
                          <button type="button" aria-pressed={listSort === "name"} className={listSort === "name" ? "selected" : ""} onClick={() => setListSort("name")}>名称</button>
                        </div>
                        <p>
                          {listSort === "name"
                            ? "当前按完整名称拼音排序；切回优先级后可调整顺序。"
                            : listFilter !== "all"
                              ? "筛选中，优先级调整已暂停；清除筛选后可调整完整顺序。"
                              : "拖动手柄，或使用上移、下移按钮调整优先级。"}
                        </p>
                      </div>
                      {visibleFollowIds.length ? (
                        <AnimeCollection mode={displayMode}>
                          {visibleFollowIds.map((seriesId, index) => {
                            const follow = library?.follows.find((item) => item.seriesId === seriesId);
                            if (!follow) return null;
                            const series = library?.series.find((item) => item.id === seriesId);
                            const canReorder = reorderAllowed && !busy;
                            if (!series) {
                              return (
                                <AnimeEntry key={seriesId} title="节目资料待同步" className="missing-series-row"
                                  leading={<OperationButton type="button" className="priority-handle" aria-label={`拖动或调整${seriesId}优先级`} busy={busy} disabled={!reorderAllowed} draggable={canReorder}
                                    onDragStart={(event) => { draggedSeriesId.current = seriesId; event.dataTransfer.setData("text/plain", seriesId); event.dataTransfer.effectAllowed = "move"; }}>
                                    <span aria-hidden="true">⠿</span>
                                  </OperationButton>}
                                  actions={<div className="library-actions">
                                    <OperationButton type="button" className="text-action unfollow-action" busy={busy} disabled={needsLibraryRefresh} aria-busy={pendingMutation?.action === "unfollow" && pendingMutation.seriesId === seriesId} onClick={() => void perform("unfollow", { seriesId }, "已移出追番，其他记录不受影响。")}>{pendingMutation?.action === "unfollow" && pendingMutation.seriesId === seriesId ? "正在取消…" : "取消追番"}</OperationButton>
                                    <PriorityMoveButtons index={index} count={visibleFollowIds.length} busy={busy} disabled={!reorderAllowed} onMove={(direction) => void movePriority(seriesId, direction)} />
                                  </div>}
                                >
                                  <div className="library-details"><p>该追番记录会保留在完整优先级顺序中。</p></div>
                                </AnimeEntry>
                              );
                            }
                            const latest = latestPublishedEpisode(series, now);
                            const supported = isSupportedPlatform(series.platform);
                            return (
                              <AnimeEntry
                                title={series.title}
                                cover={series.cover}
                                titleExtras={<>{follow.paused && <small>已暂停</small>}{!supported && <small>平台暂不可用</small>}{series.metadataPending && <small>名称待核验</small>}</>}
                                className={supported ? "" : "unsupported-platform"}
                                key={series.id}
                                onDragOver={(event) => { if (canReorder && draggedSeriesId.current && draggedSeriesId.current !== seriesId) event.preventDefault(); }}
                                onDrop={(event) => { event.preventDefault(); const source = draggedSeriesId.current || event.dataTransfer.getData("text/plain"); draggedSeriesId.current = null; if (source) void movePriorityBefore(source, seriesId); }}
                                onDragEnd={() => { draggedSeriesId.current = null; }}
                                leading={<OperationButton type="button" className="priority-handle" aria-label={`拖动调整${series.title}优先级`} busy={busy} disabled={!reorderAllowed} draggable={canReorder}
                                  onDragStart={(event) => { draggedSeriesId.current = series.id; event.dataTransfer.setData("text/plain", series.id); event.dataTransfer.effectAllowed = "move"; }}>
                                  <span aria-hidden="true">⠿</span>
                                </OperationButton>}
                                actions={<div className="library-actions">
                                  {supported ? (
                                    <a className="secondary-action" href={series.url} target="_blank" rel="noopener noreferrer" onClick={() => openOfficial(series)}>官方播放 <ExternalLink size={13} /></a>
                                  ) : <button className="secondary-action" disabled title="暂不支持该平台">平台暂不可用</button>}
                                  {supported && <button type="button" className="secondary-action" onClick={() => setJumping({ series, episode: Math.max(1, follow.currentEpisode + Number(follow.episodeCompleted)) })}>跳转集数</button>}
                                  <OperationButton className="secondary-action" busy={busy} disabled={needsLibraryRefresh || !supported} onClick={() => editProgress({ series, follow })}>修改进度</OperationButton>
                                  <OperationButton className="text-action unfollow-action" busy={busy} disabled={needsLibraryRefresh} aria-busy={pendingMutation?.action === "unfollow" && pendingMutation.seriesId === series.id} onClick={() => void perform("unfollow", { seriesId: series.id }, "已移出追番，其他记录不受影响。")}>{pendingMutation?.action === "unfollow" && pendingMutation.seriesId === series.id ? "正在取消…" : "取消追番"}</OperationButton>
                                  <PriorityMoveButtons index={index} count={visibleFollowIds.length} busy={busy} disabled={!reorderAllowed} onMove={(direction) => void movePriority(seriesId, direction)} />
                                </div>}
                              >
                                <div className="library-details">
                                  <p>
                                    {platforms[series.platform]?.name || "平台待识别"} · {progressLabel(follow)} · {latest !== null ? `已核验至 ${latest} 集` : "最新集数待核验"}
                                  </p>
                                  <Verification series={series} stale={now - Date.parse(series.lastScanAt || series.checkedAt) > 2 * 86400000} />
                                </div>
                              </AnimeEntry>
                            );
                          })}
                        </AnimeCollection>
                      ) : (
                        <p className="filter-empty">当前筛选下没有作品。再次点击统计按钮可清除筛选。</p>
                      )}
                    </section>
                    </>}
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
        </div>
      </main>
      <Toaster theme="dark" position="top-right" closeButton containerAriaLabel="操作提示" toastOptions={{ closeButtonAriaLabel: "关闭提示" }} />
      {needsLibraryRefresh && mode !== "guest" && (
        <div className="notice library-recovery-notice" role="status">
          <span>当前记录等待重新加载，保存操作已暂停。</span>
          <OperationButton className="secondary-action" busy={busy} onClick={() => void refreshLibrary()} aria-busy={pendingMutation?.action === "library"}>
            <RefreshCw size={14} />重新加载记录
          </OperationButton>
        </div>
      )}
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
                <button type="submit" className="primary-action" disabled={sending || verifying}>{verifying ? "正在加载追番记录…" : "重试确认账号并加载记录"}</button>
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
              "已确认官方节目名称并加入追番；最新集数以官网核验结果为准。",
            );
            if (success) {
              setSubmitOpen(false);
              setView("library");
            }
          }}
        />
      )}
      {jumping && mode === "cloud" && library && (
        <EpisodeJumpDialog
          key={`${library.user.uid}:${jumping.series.id}`}
          series={jumping.series}
          initialEpisode={jumping.episode}
          onClose={() => setJumping(null)}
          onResolve={(episode) => call("resolveEpisode", { url: jumping.series.url, episode }, library.user.uid)}
          isCurrentAccount={() => modeRef.current === "cloud" && accountUserId.current === library.user.uid}
          onOpened={() => openOfficial(jumping.series)}
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
  blocked: boolean;
  onOpen: (series: Anime) => void;
  onJump: (series: Anime, episode: number) => void;
  onEdit: (data: { series: Anime; follow: WatchState }) => void;
  onComplete: (series: Anime, follow: WatchState) => void;
};
function PlaybackActions({
  candidate,
  busy,
  blocked,
  onOpen,
  onJump,
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
      {isSupportedPlatform(candidate.series.platform) && <button
        type="button"
        className="secondary-action"
        onClick={() => onJump(candidate.series, candidate.nextEpisode)}
      >跳转集数</button>}
      {candidate.unwatched > 0 && (
        <OperationButton
          className="secondary-action"
          busy={busy}
          disabled={blocked || !isSupportedPlatform(candidate.series.platform)}
          onClick={() => onComplete(candidate.series, candidate.follow)}
        >
          <Check size={15} />
          看完第 {candidate.nextEpisode} 集
        </OperationButton>
      )}
      <OperationButton
        className="text-action"
        busy={busy}
        disabled={blocked || !isSupportedPlatform(candidate.series.platform)}
        onClick={() =>
          onEdit({ series: candidate.series, follow: candidate.follow })
        }
      >
        修改进度
      </OperationButton>
    </div>
  );
}
function PriorityMoveButtons({
  index,
  count,
  disabled,
  busy,
  onMove,
}: {
  index: number;
  count: number;
  disabled: boolean;
  busy: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <div className="priority-move-buttons" aria-label="调整优先级">
      <OperationButton type="button" aria-label="上移" busy={busy} disabled={disabled || index === 0} onClick={() => onMove(-1)}>上移</OperationButton>
      <OperationButton type="button" aria-label="下移" busy={busy} disabled={disabled || index === count - 1} onClick={() => onMove(1)}>下移</OperationButton>
    </div>
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
        合集里还没有？提交官方链接，确认节目名称后才会加入追番；识别失败不会保存。这里只上传节目信息，不上传视频文件。
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
function EpisodeJumpDialog({ series, initialEpisode, onClose, onResolve, isCurrentAccount, onOpened }: {
  series: Anime;
  initialEpisode: number;
  onClose: () => void;
  onResolve: (episode: number) => Promise<unknown>;
  isCurrentAccount: () => boolean;
  onOpened: () => void;
}) {
  const [episode, setEpisode] = useState(String(initialEpisode));
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState<{ episode: number; url: string } | null>(null);
  const active = useRef(true);
  const request = useRef(0);
  const pendingWindow = useRef<Window | null>(null);
  const episodeInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    active.current = true;
    episodeInput.current?.focus();
    return () => { active.current = false; pendingWindow.current?.close(); };
  }, []);
  const numericEpisode = Number(episode);
  const valid = /^\d{1,5}$/u.test(episode.trim()) && Number.isSafeInteger(numericEpisode) && numericEpisode >= 1 && numericEpisode <= 10000;
  async function jump(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || resolving) return;
    const id = ++request.current;
    const current = () => active.current && id === request.current && isCurrentAccount();
    setResolving(true);
    setError("");
    setResolved(null);
    try {
      const url = await openEpisodePlayback({ platform: series.platform, episode: numericEpisode,
        openWindow: () => (pendingWindow.current = window.open("about:blank", "_blank")),
        resolve: () => onResolve(numericEpisode), isActive: current, onOpened });
      if (url && current()) setResolved({ episode: numericEpisode, url });
    } catch (error) {
      if (current()) setError(errorText(error));
    } finally {
      pendingWindow.current = null;
      if (current()) setResolving(false);
    }
  }
  return (
    <DialogFrame title="跳转到指定集数" onClose={() => { active.current = false; request.current++; pendingWindow.current?.close(); onClose(); }}>
      <p className="dialog-description">{series.title} · {platforms[series.platform]?.name}</p>
      <form onSubmit={jump}>
        <label htmlFor="jump-episode">想看第几集</label>
        <input ref={episodeInput} id="jump-episode" autoFocus type="number" inputMode="numeric" required min={1} max={10000} step={1}
          value={episode} disabled={resolving} onChange={(event) => { setEpisode(event.target.value); setError(""); setResolved(null); }} />
        <p className="field-note">输入正片集号，在新标签页打开官方单集。观看进度由你手动确认。</p>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary-action" disabled={resolving || !valid} aria-busy={resolving}>
          {resolving ? "正在查找官方单集…" : `跳转到第 ${valid ? numericEpisode : "…"} 集`}
          <ExternalLink size={14} />
        </button>
        {resolved && <p role="status" className="field-note">链接已就绪。如未自动打开，<a href={resolved.url} target="_blank" rel="noopener noreferrer" onClick={onOpened}>点击观看第 {resolved.episode} 集</a>。</p>}
        {error && <a className="secondary-action" href={series.url} target="_blank" rel="noopener noreferrer" onClick={onOpened}>前往官方作品页选集 <ExternalLink size={14} /></a>}
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
