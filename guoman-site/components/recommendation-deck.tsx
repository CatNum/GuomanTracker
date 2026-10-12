"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Layers3, X } from "lucide-react";
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
  // A render-phase adjustment prevents a removed or caught-up candidate from
  // remaining selected while avoiding a stale-detail frame after props change.
  if (!ids.includes(selectedId) && selectedId !== (ids[0] || "")) {
    setSelectedId(ids[0] || "");
    setDetailOpen(false);
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
  const cards = windowIds.map((id, slot) => {
    const candidate = byId.get(id);
    if (!candidate) return null;
    const active = id === effectiveId;
    const windowCenter = (windowIds.length - 1) / 2;
    const offset = slot - windowCenter;
    const cardStyle = {
      "--shift": `${offset * 96}px`,
      "--shift-mobile": `${(slot - selectedSlot) * 44}px`,
      "--arc": `${Math.abs(offset) * 10}px`,
      "--arc-mobile": `${Math.abs(offset) * 6}px`,
      "--tilt": `${offset * 4}deg`,
      "--tilt-mobile": `${offset * 2.4}deg`,
      "--lift": active ? "110px" : "0px",
      "--lift-mobile": active ? "90px" : "0px",
      zIndex: slot * 10 + (active ? 5 : 0),
    } as CSSProperties;
    return (
      <button
        key={id}
        ref={(node) => { if (node) cardRefs.current.set(id, node); else cardRefs.current.delete(id); }}
        type="button"
        className={`${styles.card} ${active ? styles.active : ""}`}
        data-tone={ids.indexOf(id) % 5}
        style={cardStyle}
        aria-label={`${candidate.series.title}，还有 ${candidate.unwatched} 集未看${active ? "，当前选中，再次激活查看详情" : "，激活后选中"}`}
        aria-pressed={active}
        onClick={() => select(id)}
      >
        <span className={styles.posterFallback} aria-hidden="true"><Layers3 size={42} strokeWidth={1.1} /></span>
        {candidate.series.cover && <img key={candidate.series.cover} className={styles.poster} src={candidate.series.cover} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
        <span className={styles.shade} aria-hidden="true" />
        <span className={styles.cardTop}>
          <span className={styles.cardStatus}>{active ? "当前选中" : "有未看内容"}</span>
          <span className={styles.cardNumber}>{String(ids.indexOf(id) + 1).padStart(2, "0")}</span>
        </span>
        <span className={styles.cardBottom}>
          <span className={styles.unwatched}>还有 {candidate.unwatched} 集未看</span>
          <strong>{candidate.series.title}</strong>
          <span className={styles.cardProgress}>从第 {candidate.nextEpisode} 集继续</span>
          <span className={styles.cardCue}>{active ? "再次点击查看详情" : "点击选中"}</span>
        </span>
      </button>
    );
  });

  function select(id: string) {
    if (id === effectiveId) {
      setDetailOpen(true);
      return;
    }
    dialogRef.current?.close();
    setSelectedId(id);
    setDetailOpen(false);
  }

  function move(direction: -1 | 1) {
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
    if (returnFocus) cardRefs.current.get(effectiveId)?.focus();
  }

  function handoffDialogAction(action: () => void) {
    pendingDialogAction.current = action;
    closeDetails(false);
  }

  function onDeckKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!stageRef.current?.contains(event.target as Node)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      move(event.key === "ArrowLeft" ? -1 : 1);
    }
  }

  if (!selected) return null;

  return (
    <section className={styles.root} aria-label="未看追番推荐" onKeyDown={onDeckKeyDown}>
      <div className={styles.heading}>
        <div className={styles.headingMain}>
          <span className={styles.deckMark}><Layers3 size={15} /> 追番卡组</span>
          <div>
            <h2>现在，从哪一部继续？</h2>
            <p>按追番优先级排列 · 共 {ids.length} 部有未看内容</p>
          </div>
        </div>
        <p className={styles.hint}>点击切换卡片，再点当前卡片查看详情</p>
      </div>
      <div className={styles.stage} ref={stageRef} aria-label="推荐卡片，左右方向键切换">
        <div className={styles.cards}>
          {cards}
        </div>
      </div>
      <div className={styles.toolbar}>
        <span className={styles.position} aria-live="polite">{selected.series.title} · {selectedIndex + 1} / {ids.length}</span>
        <div className={styles.controls}>
          <button type="button" aria-label="上一部追番" onClick={() => move(-1)} disabled={selectedIndex <= 0}><ChevronLeft size={20} /></button>
          <button type="button" aria-label="查看当前卡片详情" onClick={() => setDetailOpen(true)}>查看详情</button>
          <button type="button" aria-label="下一部追番" onClick={() => move(1)} disabled={selectedIndex >= ids.length - 1}><ChevronRight size={20} /></button>
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
