/**
 * 「上次以来」（T12c，ux.md 场景 1 / 6）：上次看协作视图之后，台账上发生的事 → 首页顶部最多 5 条摘要 + 变过的任务集合（线上打小圆点）。
 * 输入是总览 ?since= 下发的 sinceEvents（src/lib/ledger-since.ts：已滤掉导入回填与项目级事件）。
 * 每条任务只说最要紧的一件：出问题 → 上线 / 完成 → 审查通过 → 新派发 → 其余推进；同档取最近的。单测 tests/web-collab-since.test.ts。
 */
import type { LedgerEventView, LedgerTaskView, Tone, Tr } from "./collab-model";
import { fillParams } from "@/lib/i18n-fill";

const zh: Tr = fillParams;

export const SINCE_MAX = 5;

type Rank = 0 | 1 | 2 | 3 | 4;
const TONE_OF: Record<Rank, Tone> = { 0: "red", 1: "green", 2: "green", 3: "neutral", 4: "neutral" };

export interface SinceItem {
  taskId: string;
  title: string;
  text: string;
  tone: Tone;
  ts: number;
  rank: Rank;
}

export interface SinceDigest {
  items: SinceItem[];
  /** 超出 SINCE_MAX 的条数（「另 N 件」） */
  more: number;
  /** 这段时间里有过事件的任务 */
  changed: Set<string>;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** 一条事件在摘要里的档位与说法；null = 不值得说（交付、改字段这类） */
function classify(e: LedgerEventView, tr: Tr): { rank: Rank; text: string } | null {
  const id = e.target;
  const d = e.data;
  switch (e.kind) {
    case "rollback":
      return { rank: 0, text: tr("{id} 回滚", { id }) };
    case "verify":
      return d.result === "fail" ? { rank: 0, text: tr("{id} 线上验证失败", { id }) } : { rank: 1, text: tr("{id} 验证通过", { id }) };
    case "deploy":
      return { rank: 1, text: tr("{id} 上线", { id }) };
    case "review": {
      const n = num(d.round);
      if (d.verdict === "pass") return { rank: 2, text: tr("{id} 审查通过", { id }) };
      return { rank: 0, text: n ? tr("{id} 被退回返工 · 第 {n} 轮", { id, n }) : tr("{id} 被退回返工", { id }) };
    }
    case "task":
      return d.op === "new" ? { rank: 3, text: tr("新派 {id}", { id }) } : null;
    case "stage":
      return stageText(id, String(d.to), num(d.round), tr);
    default:
      return null;
  }
}

function stageText(id: string, to: string, round: number | null, tr: Tr): { rank: Rank; text: string } | null {
  switch (to) {
    case "blocked":
      return { rank: 0, text: tr("{id} 受阻", { id }) };
    case "live":
      return { rank: 1, text: tr("{id} 上线", { id }) };
    case "done":
    case "verified":
      return { rank: 1, text: tr("{id} 完成", { id }) };
    case "cancelled":
      return { rank: 4, text: tr("{id} 取消", { id }) };
    case "restate":
      return { rank: 4, text: tr("{id} 开始复述", { id }) };
    case "build":
      return { rank: 4, text: tr("{id} 开工", { id }) };
    case "review":
      return { rank: 4, text: round ? tr("{id} 交付审查 · 第 {n} 轮", { id, n: round }) : tr("{id} 交付审查", { id }) };
    case "merge":
      return { rank: 4, text: tr("{id} 进入合并", { id }) };
    // review → fix 同一时刻有一条 review 事件（带轮次），那条说；spec 不是推进
    default:
      return null;
  }
}

export function sinceDigest(events: readonly LedgerEventView[], tasks: readonly Pick<LedgerTaskView, "id" | "title">[], tr: Tr = zh): SinceDigest {
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const best = new Map<string, SinceItem>();
  const changed = new Set<string>();
  for (const e of events) {
    if (!e.target) continue;
    changed.add(e.target);
    const c = classify(e, tr);
    if (!c) continue;
    const cur = best.get(e.target);
    // 同档取更近的（事件按 seq 升序来，后到的 ts 不会更早）
    if (!cur || c.rank <= cur.rank) best.set(e.target, { taskId: e.target, title: titles.get(e.target) ?? "", text: c.text, tone: TONE_OF[c.rank], ts: e.ts, rank: c.rank });
  }
  const all = [...best.values()].sort((a, b) => a.rank - b.rank || b.ts - a.ts);
  return { items: all.slice(0, SINCE_MAX), more: Math.max(0, all.length - SINCE_MAX), changed };
}
