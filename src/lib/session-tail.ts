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

export interface SessionTailInfo {
  /** 最后一条真实对话(user/assistant)的时间；窗内找不到为 null（**不退 mtime**） */
  convTs: number | null;
  /** 最近一条 assistant 的 usage 合计 ≈ 当前上下文占用 token 数 */
  ctxTokens: number | null;
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

/** 逆序扫描一段 jsonl 文本，取每个字段的首个命中（= 时间上最后一条） */
export function scanSessionTail(text: string): SessionTailInfo {
  const lines = text.split("\n");
  let convTs: number | null = null;
  let ctxTokens: number | null = null;
  let model: string | null = null;
  let modelTs: number | null = null;
  let effort: string | null = null;
  let effortTs: number | null = null;
  for (
    let i = lines.length - 1;
    i >= 0 && (convTs === null || ctxTokens === null || model === null || effort === null);
    i--
  ) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      // compact 边界比最近一条 assistant 更新时,占用以 postTokens 为准——
      // 否则压缩刚完、新回合未跑的窗口里,轮询会把 ctx 徽章顶回压缩前的值
      if (ctxTokens === null && rec.type === "system" && rec.subtype === "compact_boundary") {
        const post = rec.compactMetadata?.postTokens;
        if (typeof post === "number") ctxTokens = post;
      }
      // 上下文占用:最近一条带 usage 的 assistant——input + cache 读写就是
      // 本轮进模型的全部上下文(web 端「context 快满」指示的数据源)。
      // 合计为 0 的跳过:restart 回放命令产生的「No response requested.」等
      // 合成记录 usage 全 0,采纳它会让全列表 ctx 归零(2026-07-14 CC 升级
      // 全量 restart 后「各会话上下文占用只剩一个」的根因)
      if (ctxTokens === null && rec.type === "assistant") {
        const u = rec.message?.usage;
        if (u && typeof u.input_tokens === "number") {
          const total =
            u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (total > 0) ctxTokens = total;
        }
      }
      // 当前模型:最近一条 assistant 的 message.model(错误占位的 "<synthetic>" 跳过)
      if (model === null && rec.type === "assistant") {
        const m = rec.message?.model;
        if (typeof m === "string" && m && !m.startsWith("<")) {
          model = m;
          const t = Date.parse(rec.timestamp);
          modelTs = Number.isFinite(t) ? t : null;
        }
      }
      // 会话内 /effort 切换:stdout 自述("Kept/Set effort level as/to xxx")
      if (effort === null && rec.type === "user") {
        const c = rec.message?.content;
        const body = typeof c === "string" ? c : "";
        const em = body.includes("local-command-stdout")
          ? body.match(/(?:Kept|Set) effort level (?:as|to) (\w+)/)
          : null;
        if (em) {
          effort = em[1];
          const t = Date.parse(rec.timestamp);
          effortTs = Number.isFinite(t) ? t : null;
        }
      }
      if (convTs === null && (rec.type === "user" || rec.type === "assistant") && typeof rec.timestamp === "string") {
        // TUI 命令记录（批量 /model 之类）不算对话——不跳过的话一次批量维护
        // 会让全部 agent 的「最后对话」并列在同一时刻
        if (rec.type === "user") {
          const c = rec.message?.content;
          const body = typeof c === "string" ? c : "";
          if (CMD_RECORD_RE.test(body)) continue;
        }
        // restart/resume 回放排队命令时,CC 会产出一条礼节性 assistant
        // 「No response requested.」——不是真对话,不排除的话每次 restart
        // 都把该 agent 顶到列表最前(owner 2026-07-14:「重启不算用户真正的会话」)
        if (rec.type === "assistant") {
          const c = rec.message?.content;
          const txt = Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("")
            : typeof c === "string" ? c : "";
          if (NO_RESPONSE_RE.test(txt)) continue;
        }
        const t = Date.parse(rec.timestamp);
        if (Number.isFinite(t)) convTs = t;
      }
    } catch {
      /* tail 起点切到半行 */
    }
  }
  return { convTs, ctxTokens, model, modelTs, effort, effortTs };
}
