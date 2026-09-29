"use client";
/**
 * 步骤线（T51）：StepLine = 详情里的整条竖线（每格：步骤名、执行者 + 实例徽标、模型、状态、head、结论、本机核过 / 凭声明），
 * StepDots = 列表里的一行简版（一排小圆点 + 当前步骤和接手人）。数据模型在 collab-step-line-model.ts；只画不算。
 * 单独成组件、单独的样式文件：团队栏（T55）也改 web/features/collab，这样两边不碰同一段代码。
 */
import type { Tr } from "./collab-model";
import { Icon, type IconName } from "./collab-icons";
import { WAIT_LABEL, type StepLineView, type StepSlot, type WaitKind } from "./collab-step-line-model";
import st from "./collab-step-line.module.css";

const DOT: Record<string, string> = { done: st.sDone, delivered: st.sDelivered, assigned: st.sAssigned };
const dotClass = (s: StepSlot) => (s.filled ? DOT[s.state ?? "assigned"] ?? st.sAssigned : st.sEmpty);
const WAIT_CLASS: Record<WaitKind, string> = { blocked: st.wBlocked, owner: st.wOwner, review: st.wReview };
const WAIT_ICON: Record<WaitKind, IconName> = { blocked: "rotateCcw", owner: "hourglass", review: "shieldCheck" };
const STATE_LABEL: Record<string, string> = { assigned: "已派", delivered: "已交付", done: "已完成" };
const VERDICT: Record<string, string> = { pass: "通过", changes: "要改", block: "拦下" };

export function WaitBadge({ wait, tr }: { wait: WaitKind; tr: Tr }) {
  return (
    <span className={`${st.wait} ${WAIT_CLASS[wait]}`} data-wait={wait}>
      <Icon name={WAIT_ICON[wait]} size={11} />
      {tr(WAIT_LABEL[wait])}
    </span>
  );
}

function Who({ s, tr }: { s: StepSlot; tr: Tr }) {
  if (!s.filled) return <span className={st.tag}>{tr("未派")}</span>;
  return (
    <span className={st.who}>
      <Icon name={s.kind === "human" ? "user" : "code"} size={11} />
      {s.executor}
      {s.instance && <span className={st.inst} title={tr("别的实例")}>@{s.instance}</span>}
    </span>
  );
}

function Meta({ s, tr }: { s: StepSlot; tr: Tr }) {
  const bits: React.ReactNode[] = [];
  if (s.state) bits.push(<span key="st">{tr(STATE_LABEL[s.state] ?? s.state)}{s.round > 0 ? ` · R${s.round}` : ""}</span>);
  if (s.heads) bits.push(<span key="hd" className={st.mono}>{s.heads}</span>);
  if (s.verdict) bits.push(<span key="vd" className={st[s.verdict]}>{tr(VERDICT[s.verdict])}</span>);
  if (s.model) {
    bits.push(s.model.claimed
      ? <span key="md" className={st.claimed} title={tr("对方自报，本机核不了")}>{tr("自报模型 {m}（凭声明）", { m: s.model.name })}</span>
      : <span key="md">{s.model.name}</span>);
  }
  if (s.verified) {
    const own = s.verified.startsWith("本机核过");
    bits.push(own
      ? <span key="vf" className={st.checked}><Icon name="shieldCheck" size={11} />{tr(s.verified)}</span>
      : <span key="vf" className={st.claimed}>{tr(s.verified)}</span>);
  }
  return bits.length ? <div className={st.meta}>{bits}</div> : null;
}

/** 详情里的整条线：当前这一格高亮并挂等待徽标 */
export function StepLine({ v, tr }: { v: StepLineView; tr: Tr }) {
  return (
    <>
      {v.derivedOnly && <p className={st.inferred}>{tr("老卡没有逐步记录，下面是按负责人推断的")}</p>}
      <ol className={st.line}>
        {v.slots.map((s) => (
          <li key={s.key} className={`${st.slot} ${s.current ? st.cur : ""} ${s.filled ? "" : st.empty}`} data-step={s.key} aria-current={s.current ? "step" : undefined}>
            <i className={`${st.dot} ${dotClass(s)}`} />
            <div className={st.body}>
              <div className={st.h}>
                <span className={st.lb}>{tr(s.label)}{s.final ? ` · ${tr("终审")}` : ""}</span>
                <Who s={s} tr={tr} />
                {s.derived && <span className={st.tag}>{tr("推断")}</span>}
                {s.current && <span className={`${st.tag} ${st.curTag}`}>{tr("当前")}</span>}
                {s.current && v.wait && <WaitBadge wait={v.wait} tr={tr} />}
              </div>
              <Meta s={s} tr={tr} />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/** 列表里的一行：一排点 + 「当前步骤 · 接手人」+ 等待徽标 */
export function StepDots({ v, tr }: { v: StepLineView; tr: Tr }) {
  const c = v.current;
  return (
    <div className={st.mini} data-step-dots>
      <span className={st.dots} aria-hidden>
        {v.slots.map((s) => <i key={s.key} className={`${st.dot} ${dotClass(s)} ${s.current ? st.curDot : ""}`} title={tr(s.label)} />)}
      </span>
      {c && (
        <span className={st.miniText}>
          <b>{tr(c.label)}</b>
          {c.executor ? ` · ${c.executor}${c.instance ? `@${c.instance}` : ""}` : ""}
        </span>
      )}
      {v.wait && <WaitBadge wait={v.wait} tr={tr} />}
    </div>
  );
}
