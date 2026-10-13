"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Layers3, Play, X } from "lucide-react";
import { platforms } from "@/lib/catalog";
import type { WatchCandidate } from "@/lib/watching";
import { validDeckSelection, visibleDeckIds } from "@/lib/recommendation-deck";
import styles from "./recommendation-deck.module.css";

type Props = {
  candidates: WatchCandidate[];
  renderDetails: (candidate: WatchCandidate, onEditProgress: (edit: () => void) => void) => ReactNode;
};

function DetailsContent({
  candidate,
  renderDetails,
  onEditProgress,
}: {
  candidate: WatchCandidate;
  renderDetails: Props["renderDetails"];
  onEditProgress: (edit: () => void) => void;
}) {
  return renderDetails(candidate, onEditProgress);
}

export default function RecommendationDeck({ candidates, renderDetails }: Props) {
  const ids = useMemo(() => candidates.map((candidate) => candidate.series.id), [candidates]);
  const [selectedId, setSelectedId] = useState(ids[0] || "");
  const [detailOpen, setDetailOpen] = useState(false);
  const [drawingId, setDrawingId] = useState<string | null>(null);
  // A render-phase adjustment prevents a removed or caught-up candidate from
  // remaining selected while avoiding a stale-detail frame after props change.
  if (!ids.includes(selectedId) && selectedId !== (ids[0] || "")) {
    setSelectedId(ids[0] || "");
    setDetailOpen(false);
    setDrawingId(null);
  }
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingDialogAction = useRef<(() => void) | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailsId = useId();
  const titleId = useId();
  const effectiveId = validDeckSelection(ids, selectedId, ids[0] || "");
  const selectedIndex = ids.indexOf(effectiveId);
  const selected = candidates[selectedIndex];
  const windowIds = visibleDeckIds(ids, effectiveId);
  const selectedSlot = windowIds.indexOf(effectiveId);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.series.id, candidate])), [candidates]);
  const modalOpen = detailOpen && !!selected;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!modalOpen) {
      if (dialog.open) dialog.close();
      const pendingAction = pendingDialogAction.current;
      if (pendingAction) {
        pendingDialogAction.current = null;
        queueMicrotask(pendingAction);
      }
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [modalOpen]);
  useEffect(() => {
    if (!drawingId || drawingId !== effectiveId) return;
    const timer = window.setTimeout(() => {
      setDetailOpen(true);
      setDrawingId(null);
    }, 430);
    return () => window.clearTimeout(timer);
  }, [drawingId, effectiveId]);
  const cards = windowIds.map((id, slot) => {
    const candidate = byId.get(id);
    if (!candidate) return null;
    const active = id === effectiveId;
    const windowCenter = (windowIds.length - 1) / 2;
    const offset = slot - windowCenter;
    const cardStyle = {
      "--shift": `${offset * 112}px`,
      "--shift-mobile": `${(slot - selectedSlot) * 44}px`,
      "--arc": `${Math.abs(offset) * 10}px`,
      "--arc-mobile": `${Math.abs(offset) * 6}px`,
      "--tilt": `${offset * 4}deg`,
      "--tilt-mobile": `${offset * 2.4}deg`,
      "--lift": active ? "126px" : "0px",
      "--lift-mobile": active ? "96px" : "0px",
      zIndex: slot * 10 + (active ? 5 : 0),
    } as CSSProperties;
    return (
      <button
        key={id}
        ref={(node) => { if (node) cardRefs.current.set(id, node); else cardRefs.current.delete(id); }}
        type="button"
        className={`${styles.card} ${active ? styles.active : ""} ${drawingId === id ? styles.drawing : ""}`}
        data-tone={ids.indexOf(id) % 5}
        style={cardStyle}
        aria-busy={drawingId === id}
        aria-label={`${candidate.series.title}，还有 ${candidate.unwatched} 集未看${active ? "，当前选中，再次激活查看详情" : "，激活后选中"}`}
        aria-pressed={active}
        onClick={() => select(id)}
      >
        <span className={styles.posterFallback} aria-hidden="true"><Layers3 size={42} strokeWidth={1.1} /></span>
        {candidate.series.cover && <img key={candidate.series.cover} className={styles.poster} src={candidate.series.cover} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
        <span className={styles.shade} aria-hidden="true" />
        <span className={styles.cardTop}>
          <span className={styles.cardStatus}>{active ? "待抽取" : candidate.series.metadataPending ? "待核验" : candidate.series.status === "finished" ? "已完结" : candidate.series.status === "ongoing" ? "连载中" : "状态待核验"}</span>
          <span className={styles.cardNumber}>#{String(ids.indexOf(id) + 1).padStart(2, "0")}</span>
        </span>
        <span className={styles.cardBottom}>
          <span className={styles.unwatched}>{platforms[candidate.series.platform]?.name || "官方平台"} · {candidate.unwatched} 集未看</span>
          <strong>{candidate.series.title}</strong>
          <span className={styles.cardProgress}>从第 {candidate.nextEpisode} 集继续 · 已核验至 {candidate.latestEpisode} 集</span>
          <span className={styles.cardCue}>{active ? "再次点击抽取详情" : "点击选中卡牌"}</span>
        </span>
      </button>
    );
  });

  function drawCurrent() {
    if (drawingId || modalOpen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setDetailOpen(true);
    else setDrawingId(effectiveId);
  }

  function select(id: string) {
    if (drawingId) return;
    if (id === effectiveId) {
      drawCurrent();
      return;
    }
    dialogRef.current?.close();
    setSelectedId(id);
    setDetailOpen(false);
  }

  function move(direction: -1 | 1) {
    if (drawingId) return;
    const next = ids[selectedIndex + direction];
    if (!next) return;
    setSelectedId(next);
    dialogRef.current?.close();
    setDetailOpen(false);
    requestAnimationFrame(() => cardRefs.current.get(next)?.focus());
  }

  function closeDetails(returnFocus = true) {
    if (dialogRef.current?.open) dialogRef.current.close();
    setDetailOpen(false);
    setDrawingId(null);
    if (returnFocus) cardRefs.current.get(effectiveId)?.focus();
  }

  function handoffDialogAction(action: () => void) {
    pendingDialogAction.current = action;
    closeDetails(false);
  }

  function onDeckKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLElement && event.target.closest("dialog")) return;
    if (!stageRef.current?.contains(event.target as Node)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      move(event.key === "ArrowLeft" ? -1 : 1);
    } else if ((event.key === "Enter" || event.key === " ") && event.target === stageRef.current) {
      event.preventDefault();
      drawCurrent();
    }
  }

  if (!selected) return null;

  return (
    <section className={styles.root} aria-label="未看追番推荐" onKeyDown={onDeckKeyDown}>
      <div className={styles.heading}>
        <div className={styles.headingMain}>
          <span className={styles.deckMark}><span /> CARD DECK</span>
          <div>
            <h1>追番扑克牌夹 <span>共 {ids.length} 部</span></h1>
            <p>要看什么 · 按你的追番优先级推荐</p>
          </div>
        </div>
        <p className={styles.hint}>点击卡牌切为待抽 · 再次点击翻转抽取详情</p>
      </div>
      <div className={styles.stage} ref={stageRef} tabIndex={0} aria-label="推荐卡片，左右方向键切换，回车或空格抽取详情">
        <div className={styles.cards}>
          {cards}
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.keyboardHint}><span><kbd>←</kbd> <kbd>→</kbd> 切换牌位</span><span><kbd>Space</kbd> / <kbd>Enter</kbd> 抽取详情</span><span className={styles.position}>{selectedIndex + 1} / {ids.length}</span></div>
        <div className={styles.controls}>
          <button type="button" aria-label="上一部追番" onClick={() => move(-1)} disabled={!!drawingId || selectedIndex <= 0}><ChevronLeft size={20} /></button>
          <button type="button" aria-label="查看当前卡片详情" onClick={drawCurrent} disabled={!!drawingId}><Play size={13} fill="currentColor"/>{drawingId ? "正在抽取" : "抽取此牌详情"}</button>
          <button type="button" aria-label="下一部追番" onClick={() => move(1)} disabled={!!drawingId || selectedIndex >= ids.length - 1}><ChevronRight size={20} /></button>
        </div>
      </div>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        tabIndex={-1}
        aria-labelledby={titleId}
        onCancel={(event) => { event.preventDefault(); closeDetails(); }}
        onClick={(event) => { if (event.target === event.currentTarget) closeDetails(); }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const dialog = dialogRef.current;
          const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(
            "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
          ) || []).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && !element.closest("[inert]"));
          if (!focusable.length) {
            event.preventDefault();
            dialog?.focus();
            return;
          }
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className={styles.dialogPanel} id={detailsId}>
          <header className={styles.dialogHeader}>
            <h2 id={titleId}>{selected.series.title} · 追番详情</h2>
            <button type="button" className={styles.close} aria-label="关闭详情" onClick={() => closeDetails()}><X size={20} /></button>
          </header>
          <div className={styles.dialogBody}>
            <div className={styles.dialogPoster}>
              <span className={styles.dialogPosterFallback} aria-hidden="true"><Layers3 size={42} /></span>
              {selected.series.cover ? <img key={selected.series.cover} src={selected.series.cover} alt={`${selected.series.title}海报`} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
            </div>
            <div className={styles.dialogContent}>
              <DetailsContent candidate={selected} renderDetails={renderDetails} onEditProgress={handoffDialogAction} />
            </div>
          </div>
        </div>
      </dialog>
    </section>
  );
}
