"use client";
/**
 * 详情里的「回放」（T12c）：按台账事件逐帧回看这条任务，阶段条画成那一刻的样子；只读。
 * 播放是等间隔一帧一帧走（不按真实时长——一条任务动辄跨好几个小时），到末帧自动停。帧的逻辑在 collab-replay.ts。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDuration, type Tr } from "./collab-model";
import { fmtEventTime, type TaskDetail } from "./collab-detail-model";
import { Icon, type IconName } from "./collab-icons";
import { hasReplay, nextIndex, replayFrames, segmentsAt } from "./collab-replay";
import base from "./collab.module.css";
import s from "./collab-v2.module.css";

const STEP_MS = 1200;
const EVENT_ICON: Record<string, IconName> = {
  task: "clipboard", stage: "zap", deliver: "gitPullRequest", review: "fileText", decision: "circleCheck",
  deploy: "zap", verify: "shieldCheck", rollback: "rotateCcw", note: "history",
};

/**
 * 收起时不拼文案、不算帧（几千条事件要几百毫秒，审查 T12C r1 P2-7），只数能成帧的事件：不到 2 帧或没有阶段证据没什么可回放。
 * homeOnly = 源声明回放只在主场（团队视图）：回放不了时按钮位置给一个点不动的「回放仅主场」，不整块消失。
 */
export function CollabReplay({ d, tr, homeOnly = false }: { d: TaskDetail; tr: Tr; homeOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!hasReplay(d.events))
    return homeOnly ? (
      <button type="button" className={`${base.btn} ${s.rpOpen}`} disabled data-home-only="replay">
        <Icon name="play" size={12} />
        {tr("回放仅主场")}
      </button>
    ) : null;
  if (!open)
    return (
      <button type="button" className={`${base.btn} ${s.rpOpen}`} onClick={() => setOpen(true)}>
        <Icon name="play" size={12} />
        {tr("回放这条任务")}
      </button>
    );
  return (
    <div className={base.sec}>
      <h5>{tr("回放")}</h5>
      <Player d={d} tr={tr} onClose={() => setOpen(false)} />
    </div>
  );
}

function Player({ d, tr, onClose }: { d: TaskDetail; tr: Tr; onClose: () => void }) {
  const frames = useMemo(() => replayFrames(d.events, tr), [d.events, tr]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const cur = frames[Math.min(i, frames.length - 1)];
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      const n = nextIndex(i, frames.length);
      if (n === null) setPlaying(false);
      else setI(n);
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [playing, i, frames.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);

  // 按钮只在能成两帧以上时出现（hasReplay）；这里再兜一次：数据异常到一帧都没有时不画
  if (!cur) return null;
  const tone = cur.stage === "fix" || cur.stage === "blocked" || cur.kind === "rollback" ? base.red : base.neutral;
  const toggle = () => {
    // 停在末帧时再点播放 = 从头再放一遍
    if (!playing && i >= frames.length - 1) setI(0);
    setPlaying((p) => !p);
  };
  return (
    <div className={`${s.rp} ${tone}`}>
      <div className={s.rpBar}>
        <span className={s.pos}>
          {i + 1} / {frames.length}
        </span>
        <button type="button" className={base.ib} aria-label={tr("上一步")} disabled={i === 0} onClick={() => (setPlaying(false), setI(i - 1))}>
          <Icon name="skipBack" size={13} />
        </button>
        <button type="button" className={base.ib} aria-label={playing ? tr("暂停") : tr("播放")} onClick={toggle}>
          <Icon name={playing ? "pause" : "play"} size={13} />
        </button>
        <button type="button" className={base.ib} aria-label={tr("下一步")} disabled={i >= frames.length - 1} onClick={() => (setPlaying(false), setI(i + 1))}>
          <Icon name="skipForward" size={13} />
        </button>
        <button type="button" className={base.ib} aria-label={tr("收起回放")} onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className={`${base.steps} ${tone}`}>
        {segmentsAt(cur, d.timeline).map((g) => (
          <div key={g.label} className={`${base.s} ${g.state === "past" ? base.past : g.state === "current" ? base.cur : ""}`}>
            <i />
            {tr(g.label)}
            <em>{g.ms > 0 ? fmtDuration(g.ms, tr) : ""}</em>
          </div>
        ))}
      </div>
      {cur.stage === null && (
        <div className={base.rr} data-stage-unknown="">
          <div className={base.tx}>{tr("阶段未知")}</div>
        </div>
      )}
      <div className={s.rpNow}>
        <span className={s.ic}>
          <Icon name={EVENT_ICON[cur.kind] ?? "history"} size={14} />
        </span>
        <div>
          <span className={s.tm}>
            {cur.approx && "≈"}
            {fmtEventTime(cur.ts, d.now, tr)}
          </span>
          {cur.text}
        </div>
      </div>
      <input type="range" className={s.rpRange} min={0} max={frames.length - 1} value={i} aria-label={tr("回放进度")}
        onChange={(e) => (setPlaying(false), setI(Number(e.target.value)))} />
      <div ref={listRef} className={s.rpList}>
        {frames.map((f, k) => (
          <button key={f.seq} type="button" data-i={k} className={`${s.rpItem} ${k === i ? s.cur : k > i ? s.fut : ""}`} onClick={() => (setPlaying(false), setI(k))}>
            <span className={s.tm}>{fmtEventTime(f.ts, d.now, tr)}</span>
            <span>{f.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
