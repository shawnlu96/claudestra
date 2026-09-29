"use client";
/**
 * 首页的一条任务线：左边标题 / 目标 / 在等谁 / 原因，右边 7 列阶段轨道 + 负责人的工位卡（手机上竖排成卡片）。
 * 工位卡停在当前列；阶段推进时 left / transform 过渡把它滑过去，只有刚推进的那一条用品牌色（ux.md「推进时只做一次短动效」）。
 */
import type { ActionKind } from "./collab-action";
import { COLUMNS, dwellText, skippedColumns, type LineView, type Tr } from "./collab-model";
import { Icon } from "./collab-icons";
import { StepDots } from "./collab-step-line";
import { stepLineView } from "./collab-step-line-model";
import s from "./collab.module.css";
import v2 from "./collab-v2.module.css";

const NCOL = COLUMNS.length;
const pos = (i: number) => ((i + 0.5) / NCOL) * 100;
/** 工位卡的水平锚点：首列左对齐、末列右对齐、中间按比例，卡片不会伸出轨道 */
const anchor = (i: number) => 14 + (72 * i) / (NCOL - 1);

const TONE = { red: s.red, amber: s.amber, neutral: s.neutral, green: s.green } as const;
const ACT_CLASS: Record<ActionKind | "waiting", string> = { thinking: s.aThinking, tool: s.aTool, waiting: s.aWaiting, idle: s.aIdle, compacting: s.aCompacting };
const ACT_LABEL: Record<ActionKind | "waiting", string> = { thinking: "思考中", tool: "运行工具", waiting: "等待", idle: "空闲", compacting: "压缩中" };

export interface LineAction {
  kind: ActionKind | "waiting";
  text: string;
}

export function LineHeaderCols({ tr }: { tr: Tr }) {
  return (
    <div className={s.hdr}>
      <div className={s.c0}>{tr("按关注度排序")}</div>
      <div className={s.cols}>
        {COLUMNS.map((c, i) => (
          <span key={c} style={{ left: `${pos(i)}%` }}>
            {tr(c)}
          </span>
        ))}
      </div>
    </div>
  );
}

function stageIcon(l: LineView, reviewing: boolean) {
  if (reviewing) return "shieldCheck" as const;
  if (l.attention === "problem") return "rotateCcw" as const;
  if (l.attention === "progress") return "zap" as const;
  return "hourglass" as const;
}

/** 列表那一行的步骤小圆点（T51）：派过人的卡才画 */
function LineSteps({ l, tr }: { l: LineView; tr: Tr }) {
  const v = stepLineView(l.stepLine, l.stage);
  return v && v.slots.some((x) => x.filled) ? <StepDots v={v} tr={tr} /> : null;
}

export function CollabLine(props: {
  line: LineView;
  action: LineAction;
  hot: boolean;
  /** 刚推进时从哪一列来（画一段品牌色的轨道 + 短标签）；不是刚推进为 null */
  hotFrom: number | null;
  selected: boolean;
  onOpen: () => void;
  tr: Tr;
  /** 上次来之后变过（T12c）：标题前一个小圆点 */
  changed?: boolean;
  /** 审查员在跑（T12c，collab-reviewers.ts）：review 阶段已改写 stageLabel，其它阶段挂这个小标 */
  reviewing?: boolean;
  reviewerTag?: string | null;
}) {
  const { line: l, action, hot, hotFrom, selected, onOpen, tr, changed, reviewing = false, reviewerTag } = props;
  const col = l.column;
  const skip = skippedColumns(l.kind);
  const actLabel = l.attention === "problem" && l.stage === "fix" ? tr("返工 R{n}", { n: Math.max(1, l.round) }) : tr(ACT_LABEL[action.kind]);
  const live = action.kind === "thinking" || action.kind === "tool" || action.kind === "compacting";
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${s.row} ${TONE[l.tone]} ${hot ? s.hot : ""} ${selected ? s.sel : ""} ${l.attention === "owner" ? s.owner : ""}`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <div className={s.info}>
        <div className={s.t1}>
          {changed && <span className={v2.chg} title={tr("上次来之后有变化")} />}
          <span className={s.tid}>{l.id}</span>
          <span className={s.ttl}>{l.title}</span>
        </div>
        {l.goal && <div className={s.goal}>{l.goal}</div>}
        <div className={s.wait}>
          <span className={s.k}>
            <Icon name={stageIcon(l, reviewing && !reviewerTag)} size={12} />
            {l.stageLabel}
          </span>
          {l.dwellMs !== null && <span className={s.dw}>· {dwellText(l, tr)}</span>}
        </div>
        {reviewerTag && (
          <div className={s.wait}>
            <span className={v2.rvTag}>
              <span className={v2.rvLive} />
              {reviewerTag}
            </span>
          </div>
        )}
        {l.reason && <div className={s.why}>{l.reason}</div>}
        <LineSteps l={l} tr={tr} />
      </div>
      <div className={s.track}>
        <i className={s.rlBase} />
        <i className={s.rlFill} style={{ width: `${pos(col) - pos(0)}%` }} />
        {hot && hotFrom !== null && hotFrom !== col && (
          <i className={s.rlHot} style={{ left: `${pos(Math.min(hotFrom, col))}%`, width: `${Math.abs(pos(col) - pos(hotFrom))}%` }} />
        )}
        {COLUMNS.map((c, i) => (
          <b key={c} className={`${s.dot} ${skip.includes(i) ? s.na : i < col ? s.past : i === col ? s.cur : ""}`} style={{ left: `${pos(i)}%` }} />
        ))}
        <div className={s.st} style={{ left: `${pos(col)}%`, transform: `translate(-${anchor(col)}%, -50%)` }}>
          {hot && hotFrom !== null && (
            <span key={`${l.id}:${l.stage}`} className={s.cap}>
              <Icon name="zap" size={12} />
              {l.stageLabel}
            </span>
          )}
          <div className={s.card}>
            <div className={s.cwho}>
              <Icon name="code" size={12} />
              <span className={s.who}>{tr("执行者")}</span>
              <span className={s.nm} title={l.agent ?? l.delegate ?? undefined}>{l.agent ?? l.delegate?.replace(/^agent-/, "") ?? tr("未派人")}</span>
              <span className={s.stg}>{tr(COLUMNS[col])}</span>
            </div>
            <div className={s.act}>
              <span className={`${s.pulse} ${ACT_CLASS[action.kind]} ${live ? s.on : ""}`} />
              <span className={s.al}>{actLabel}</span>
              {action.text && <span className={s.ad}>{action.text}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
