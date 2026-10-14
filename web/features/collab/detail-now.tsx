"use client";
/**
 * 任务详情的「现在」区块与「叫停这一轮」按钮（UXCARD1）；句子怎么拼在 detail-now-model.ts，这里只排版。
 * 叫停发的是 interruptAgent（和会话页一键中断同一个接口）：只打断执行者当前这一轮，卡不退回、调度照常。
 * 两次确认：第一次点只变成「确认叫停」，5 秒内再点才发；过时自动退回，免得误触打断正在写的执行者。
 */
import { useEffect, useRef, useState } from "react";
import { interruptAgent } from "@/lib/api/chat";
import { Icon } from "./collab-icons";
import { fmtDuration, type LineView, type Tr } from "./collab-model";
import type { NowSentence } from "./detail-now-model";
import s from "./collab.module.css";

const TONE = { red: s.red, amber: s.amber, neutral: s.neutral, green: s.green } as const;

export function NowSec({ line, total, now, action, tr }: {
  line: LineView; total: number | undefined; now: NowSentence; action: string | null; tr: Tr;
}) {
  const reason = !now.usedReason && line.reason ? line.reason : "";
  const meta = [now.next, typeof total === "number" && total >= 60_000 ? tr("已用时 {d}", { d: fmtDuration(total, tr) }) : ""].filter(Boolean);
  return (
    <div className={s.sec}>
      <h5>{tr("现在")}</h5>
      <div className={`${s.nowbox} ${TONE[line.tone]}`} data-now="box">
        <div className={s.k} data-now="who">
          <Icon name={line.attention === "problem" ? "rotateCcw" : line.attention === "progress" ? "zap" : "hourglass"} size={14} />
          {now.who}
        </div>
        {action && <div className={s.r} data-now="action">{action}</div>}
        {reason && <div className={s.r}>{reason}</div>}
        {meta.length > 0 && <div className={s.m} data-now="next">{meta.join(" · ")}</div>}
      </div>
    </div>
  );
}

const CONFIRM_MS = 5_000;
type Phase = "idle" | "confirm" | "sending" | "done" | "error";

export function StopRound({ agent, tr }: { agent: string; tr: Tr }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const later = (next: Phase, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase(next), ms);
  };
  const click = async () => {
    if (phase === "sending") return;
    if (phase !== "confirm") {
      setPhase("confirm");
      later("idle", CONFIRM_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setPhase("sending");
    // 失败只影响这次叫停：按钮写「叫停失败」，几秒后可以再点；bridge 的拒绝原因在会话页的中断按钮同样看得到
    const ok = await interruptAgent(agent).then((r) => r.ok !== false, () => false);
    setPhase(ok ? "done" : "error");
    later("idle", 3_000);
  };
  const label = { idle: "叫停这一轮", confirm: "确认叫停", sending: "正在叫停…", done: "已叫停", error: "叫停失败" }[phase];
  return (
    <button type="button" className={`${s.btn} ${s.stopRound}`} data-stop-round={phase} disabled={phase === "sending"}
      title={tr("只打断执行者当前这一轮，卡不退回、调度照常；5 秒内再点一次才发出")} onClick={() => void click()}>
      <Icon name="circleX" size={13} />
      {tr(label)}
    </button>
  );
}
