/**
 * v2.18.1+ 会话尾部解析（纯逻辑，可单测）——从 session jsonl 的尾部文本里读出
 * 「最后一条真实对话时间 / 当前上下文占用 / 实测 model / 实测 effort」。
 *
 * 为什么不能用文件 mtime 当「最近活动时间」（这是本模块存在的全部理由）：
 * CC 自己的housekeeping 会周期性 touch 会话文件——2026-08-10 实测 12 个 agent
 * 的 jsonl 在同一分钟带内被逐个 touch（间隔 43s，正好等于上一次 restart wave 的
 * 启动间隔，即每个 CC 进程各自定时摸自己的会话文件），**字节完全没变**
 * （与归档副本 cmp 一致）。拿 mtime 排序 = 拿「CC 什么时候摸过这个文件」排序。
 *
 * 因此 convTs 只认真实对话记录，且**宁可为 null 也不退回 mtime**（调用方退回
 * registry.created 更诚实）。找不到时改为**逐级放宽窗口**再找：
 * 长期只做 restart 的 agent，尾部 256KB 可能全是重启残渣（「No response
 * requested.」+ /model 命令记录 + file-history-snapshot），真实对话被挤到更早。
 * 2026-08-10 owner 报「qingniao-miniapp 我啥也没干却一直排最前」的根因就是它：
 * 256KB 窗内 0 条真实对话 → 退 mtime → CC 一 touch 就顶到列表第一。
 */

import { translateSessionLine } from "./session-source.js";

export interface SessionTailInfo {
  /** 最后一条真实对话(user/assistant)的时间；窗内找不到为 null（**不退 mtime**） */
  convTs: number | null;
  /** 最近一条 assistant 的 usage 合计 ≈ 当前上下文占用 token 数 */
  ctxTokens: number | null;
  /** 会话记录自带的上下文窗口（Codex 的 token_count 有；Claude Code 没有 → null，前端按 1M 刻度） */
  ctxWindow: number | null;
  /** 最近一条 assistant 实际用的 model id（会话内 /model 切换后即时反映，防 registry 漂移） */
  model: string | null;
  /** model 读取自的那条 assistant 记录的时间——切换端点的乐观显示靠它判断实测是否已追上 */
  modelTs: number | null;
  /** 会话内最近一次 /effort 的结果档位（stdout 自述,窗内没有则 null → 调用方回退 registry/全局） */
  effort: string | null;
  /** effort 读取自的那条记录的时间（同 modelTs 用途） */
  effortTs: number | null;
}

/** 逐级放宽的 tail 窗口：命中真实对话即停，全文读完仍无则认 null */
export const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

/** TUI 命令记录（/model、/status 之类）——不是对话 */
const CMD_RECORD_RE = /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat)/;
/** restart/resume 回放排队命令时 CC 产出的礼节性回复——不是对话 */
const NO_RESPONSE_RE = /^\s*No response requested\.?\s*$/;

/** 扫描中的累加器：每个字段取逆序首个命中（= 时间上最后一条） */
interface TailAcc extends SessionTailInfo {
  /** Codex 的「没设档位」是显式的 null（= 模型默认档），读到它就不能再往前找旧值 */
  effortSettled: boolean;
  /** 压缩边界没带压缩后占用（Pi 只记 tokensBefore）：此刻占用未知，不能往前取压缩前的旧值 */
  ctxSettled: boolean;
}

const tsOf = (rec: any): number | null => {
  const t = Date.parse(rec.timestamp);
  return Number.isFinite(t) ? t : null;
};

/** 上下文占用（及 Codex 自带的窗口） */
function takeContext(rec: any, acc: TailAcc): void {
  if (acc.ctxTokens !== null || acc.ctxSettled) return;
  // Codex：token_count 翻成的 context_usage（codex-session.codexStateRecord）
  if (rec.type === "system" && rec.subtype === "context_usage") {
    acc.ctxTokens = rec.tokens;
    acc.ctxWindow = rec.window ?? null;
    return;
  }
  // compact 边界比最近一条 assistant 更新时,占用以 postTokens 为准——
  // 否则压缩刚完、新回合未跑的窗口里,轮询会把 ctx 徽章顶回压缩前的值
  if (rec.type === "system" && rec.subtype === "compact_boundary") {
    const post = rec.compactMetadata?.postTokens;
    if (typeof post === "number") acc.ctxTokens = post;
    else acc.ctxSettled = true; // 下一轮 assistant 带 usage 后自然恢复真实值
    return;
  }
  // 上下文占用:最近一条带 usage 的 assistant——input + cache 读写就是
  // 本轮进模型的全部上下文(web 端「context 快满」指示的数据源)。
  // 合计为 0 的跳过:restart 回放命令产生的「No response requested.」等
  // 合成记录 usage 全 0,采纳它会让全列表 ctx 归零(2026-07-14 CC 升级
  // 全量 restart 后「各会话上下文占用只剩一个」的根因)
  if (rec.type === "assistant") {
    const u = rec.message?.usage;
    if (u && typeof u.input_tokens === "number") {
      const total = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (total > 0) acc.ctxTokens = total;
    }
  }
}

/** 当前模型与 effort / 思考档位 */
function takeModelEffort(rec: any, acc: TailAcc): void {
  const effortOpen = acc.effort === null && !acc.effortSettled;
  // Codex：turn_context 翻成的 model_state，模型与档位一起读（档位 null = 模型默认档）
  if (rec.type === "system" && rec.subtype === "model_state") {
    if (acc.model === null) [acc.model, acc.modelTs] = [rec.model, tsOf(rec)];
    if (effortOpen) [acc.effort, acc.effortTs, acc.effortSettled] = [rec.effort ?? null, tsOf(rec), true];
    return;
  }
  // 当前模型:最近一条 assistant 的 message.model(错误占位的 "<synthetic>" 跳过)
  if (acc.model === null && rec.type === "assistant") {
    const m = rec.message?.model;
    if (typeof m === "string" && m && !m.startsWith("<")) [acc.model, acc.modelTs] = [m, tsOf(rec)];
  }
  if (!effortOpen) return;
  // v2.23+ Pi:思考档位是独立记录(thinking_level_change),不是命令自述
  if (rec.type === "system" && rec.subtype === "thinking_level_change") {
    const lvl = rec.thinkingLevel;
    if (typeof lvl === "string" && lvl) [acc.effort, acc.effortTs] = [lvl, tsOf(rec)];
  }
  // 会话内 /effort 切换:stdout 自述("Kept/Set effort level as/to xxx")
  if (rec.type === "user") {
    const c = rec.message?.content;
    const body = typeof c === "string" ? c : "";
    const em = body.includes("local-command-stdout") ? body.match(/(?:Kept|Set) effort level (?:as|to) (\w+)/) : null;
    if (em) [acc.effort, acc.effortTs] = [em[1], tsOf(rec)];
  }
}

/** 最后一条真实对话的时间 */
function takeConvTs(rec: any, acc: TailAcc): void {
  if (acc.convTs !== null || (rec.type !== "user" && rec.type !== "assistant") || typeof rec.timestamp !== "string") return;
  // TUI 命令记录（批量 /model 之类）不算对话——不跳过的话一次批量维护
  // 会让全部 agent 的「最后对话」并列在同一时刻
  if (rec.type === "user") {
    const c = rec.message?.content;
    if (CMD_RECORD_RE.test(typeof c === "string" ? c : "")) return;
  }
  // restart/resume 回放排队命令时,CC 会产出一条礼节性 assistant
  // 「No response requested.」——不是真对话,不排除的话每次 restart
  // 都把该 agent 顶到列表最前(owner 2026-07-14:「重启不算用户真正的会话」)
  if (rec.type === "assistant") {
    const c = rec.message?.content;
    const txt = Array.isArray(c)
      ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("")
      : typeof c === "string" ? c : "";
    if (NO_RESPONSE_RE.test(txt)) return;
  }
  acc.convTs = tsOf(rec);
}

/** 逆序扫描一段 jsonl 文本，取每个字段的首个命中（= 时间上最后一条） */
export function scanSessionTail(text: string, runtime?: string): SessionTailInfo {
  const lines = text.split("\n");
  const acc: TailAcc = {
    convTs: null, ctxTokens: null, ctxWindow: null, model: null, modelTs: null, effort: null, effortTs: null, effortSettled: false, ctxSettled: false,
  };
  const done = () => acc.convTs !== null && (acc.ctxTokens !== null || acc.ctxSettled) && acc.model !== null && (acc.effort !== null || acc.effortSettled);
  for (let i = lines.length - 1; i >= 0 && !done(); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      // v2.23+ runtime 感知：Pi / Codex 的行在这里归一（usage 键名、model 位置、档位记录）
      const rec = translateSessionLine(runtime, line);
      if (!rec) continue;
      takeContext(rec, acc);
      takeModelEffort(rec, acc);
      takeConvTs(rec, acc);
    } catch {
      /* tail 起点切到半行 */
    }
  }
  const { effortSettled: _settled, ctxSettled: _ctx, ...info } = acc;
  return info;
}
