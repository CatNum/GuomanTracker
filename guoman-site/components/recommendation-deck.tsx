"use client";

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Layers3, X } from "lucide-react";
import type { WatchCandidate } from "@/lib/watching";
import { validDeckSelection, visibleDeckIds } from "@/lib/recommendation-deck";
import styles from "./recommendation-deck.module.css";

type Props = {
  candidates: WatchCandidate[];
  renderDetails: (candidate: WatchCandidate) => ReactNode;
};

export default function RecommendationDeck({ candidates, renderDetails }: Props) {
  const ids = useMemo(() => candidates.map((candidate) => candidate.series.id), [candidates]);
  const [selectedId, setSelectedId] = useState(ids[0] || "");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // A render-phase adjustment prevents a removed or caught-up candidate from
  // remaining selected while avoiding a stale-detail frame after props change.
  if (!ids.includes(selectedId) && selectedId !== (ids[0] || "")) {
    setSelectedId(ids[0] || "");
    setExpandedId(null);
  }
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailsId = useId();
  const effectiveId = validDeckSelection(ids, selectedId, ids[0] || "");
  const selectedIndex = ids.indexOf(effectiveId);
  const selected = candidates[selectedIndex];
  const windowIds = visibleDeckIds(ids, effectiveId);
  const selectedSlot = windowIds.indexOf(effectiveId);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.series.id, candidate])), [candidates]);
  const detailOpen = expandedId === effectiveId && !!selected;
  const cards = windowIds.map((id, slot) => {
    const candidate = byId.get(id);
    if (!candidate) return null;
    const active = id === effectiveId;
    const windowCenter = (windowIds.length - 1) / 2;
    const offset = slot - windowCenter;
    const selectionDistance = Math.abs(slot - selectedSlot);
    const cardStyle = {
      "--shift": `${offset * 52}px`,
      "--shift-mobile": `${(slot - selectedSlot) * 44}px`,
      "--arc": `${Math.abs(offset) * 10}px`,
      "--arc-mobile": `${Math.abs(offset) * 6}px`,
      "--tilt": `${offset * 4}deg`,
      "--tilt-mobile": `${offset * 2.4}deg`,
      "--lift": active ? "18px" : "0px",
      "--lift-mobile": active ? "12px" : "0px",
      zIndex: 100 - selectionDistance * 10 + (slot > selectedSlot ? 1 : 0),
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
        aria-expanded={active && detailOpen}
        aria-controls={active && detailOpen ? detailsId : undefined}
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
      setExpandedId((current) => current === id ? null : id);
      return;
    }
    setSelectedId(id);
    setExpandedId(null);
  }

  function move(direction: -1 | 1) {
    const next = ids[selectedIndex + direction];
    if (!next) return;
    setSelectedId(next);
    setExpandedId(null);
    requestAnimationFrame(() => cardRefs.current.get(next)?.focus());
  }

  function closeDetails() {
    setExpandedId(null);
    cardRefs.current.get(effectiveId)?.focus();
  }

  function onDeckKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && detailOpen) {
      event.preventDefault();
      closeDetails();
      return;
    }
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
          <button type="button" aria-label={detailOpen ? "收起当前卡片详情" : "展开当前卡片详情"} onClick={() => detailOpen ? closeDetails() : setExpandedId(effectiveId)}>{detailOpen ? "收起详情" : "查看详情"}</button>
          <button type="button" aria-label="下一部追番" onClick={() => move(1)} disabled={selectedIndex >= ids.length - 1}><ChevronRight size={20} /></button>
        </div>
      </div>
      {detailOpen && (
        <div className={styles.detail} id={detailsId} aria-label={`${selected.series.title}详情`}>
          <button type="button" className={styles.close} aria-label="收起详情" onClick={closeDetails}><X size={19} /></button>
          {renderDetails(selected)}
        </div>
      )}
    </section>
  );
}
