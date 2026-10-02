"use client";
/**
 * 借出中的单和日志：在跑的排前，近期已结束的在后。每行 peer、repo#pr、step、家族、状态图标，右侧是 notices 画的时间线
 * （开跑 play / 交付 check / 停止 square，待补发 clock）。有 agent 的行打开 worker 会话；没起过的 released 单只展示失败原因。
 * 状态只按 lend-model.orderPhase：收回后 live 的转圈，70 秒还 live 闪告警，journal 进终态才是已停。
 */
import { useLendT } from "./lend-i18n";
import { LendIcon, type LendIconName } from "./lend-icons";
import { isLive, orderPhase, orderTitle, timeline, type OrderPhase, type OrderView, type TimelineItem } from "./lend-model";
import css from "./lend.module.css";

const PHASE: Record<OrderPhase, { icon: LendIconName; label: string; cls: string }> = {
  waiting: { icon: "hourglass", label: "等待", cls: "text-base-content/50" },
  running: { icon: "activity", label: "在跑", cls: "text-info" },
  stopping: { icon: "loaderCircle", label: "停止中", cls: `text-warning ${css.spin}` },
  stuck: { icon: "triangleAlert", label: "停不下来", cls: `text-error ${css.blink}` },
  stopped: { icon: "square", label: "已停", cls: "text-base-content/50" },
  done: { icon: "circleCheck", label: "已交付", cls: "text-success" },
};

const STEP_ICON: Record<TimelineItem["kind"], { icon: LendIconName; label: string }> = {
  start: { icon: "play", label: "开跑" },
  delivered: { icon: "check", label: "交付" },
  stopped: { icon: "square", label: "停止" },
};

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Timeline({ order }: { order: OrderView }) {
  const t = useLendT();
  const items = timeline(order.notices);
  if (!items.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-base-content/50">
      {items.map((it) => {
        const s = STEP_ICON[it.kind];
        const title = [t(s.label), it.at !== null ? hhmm(it.at) : t("待补发"), it.why].filter(Boolean).join(" · ");
        return (
          <span key={it.kind} className="flex items-center gap-0.5" title={title}>
            <LendIcon name={it.pending ? "clock" : s.icon} size={11} />
            {it.at !== null && <span className="tabular-nums">{hhmm(it.at)}</span>}
          </span>
        );
      })}
    </span>
  );
}

function OrderRow({ order, phase, onOpen }: { order: OrderView; phase: OrderPhase; onOpen: (agent: string) => void }) {
  const t = useLendT();
  const p = PHASE[phase];
  const notStarted = order.state === "released" && order.startedAt === null;
  const body = (
    <>
      <span className={`flex shrink-0 ${p.cls}`} title={[t(p.label), order.reason].filter(Boolean).join(" · ")} aria-label={t(p.label)}>
        <LendIcon name={p.icon} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{orderTitle(order)}</span>
        <span className="block truncate text-[11px] text-base-content/50">
          {order.peer} · {order.step ?? "—"} · {order.family}
        </span>
        {notStarted && <span className="block text-[11px] text-base-content/50 break-words">
          {t("没起来")}{order.reason ? ` · ${Array.from(order.reason).slice(0, 60).join("")}` : ""}
        </span>}
      </span>
      <Timeline order={order} />
    </>
  );
  const cls = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left";
  if (!order.agent || notStarted) return <div className={cls}>{body}</div>;
  const agent = order.agent;
  return (
    <button type="button" className={`${cls} hover:bg-base-300/50`} title={t("打开会话")} onClick={() => onOpen(agent)}>
      {body}
    </button>
  );
}

export function LentOrders({ orders, stopping, now, onOpen }: {
  orders: OrderView[]; stopping: ReadonlyMap<string, number>; now: number; onOpen: (agent: string) => void;
}) {
  const t = useLendT();
  const live = orders.filter(isLive);
  const ended = orders.filter((o) => !isLive(o));
  if (!orders.length) return <div className="py-2 text-center text-xs text-base-content/40">{t("暂无借出的单")}</div>;
  return (
    <div className="space-y-0.5">
      {live.map((o) => <OrderRow key={o.orderId} order={o} phase={orderPhase(o, stopping, now)} onOpen={onOpen} />)}
      {ended.length > 0 && (
        <div className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-base-content/40">{t("近期已结束")}</div>
      )}
      {ended.map((o) => <OrderRow key={o.orderId} order={o} phase={orderPhase(o, stopping, now)} onOpen={onOpen} />)}
    </div>
  );
}
