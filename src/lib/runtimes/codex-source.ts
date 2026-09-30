/** Codex rollout 的只读会话来源，ACP 与 tmux 启动适配器共用。 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  codexLineToClaudeShape,
  codexSessionIdFromFilename,
  codexSessionsRoot,
  findCodexSessionPath,
  isCodexSessionPath,
  listCodexSessionFiles,
  newCodexTranslateState,
  readCodexMeta,
} from "../codex-session.js";
import { scanCodexStatsWindow } from "../codex-usage.js";
import { lastUserTextOf } from "./shared.js";
import type { AnyRecord, DiscoveredSession, SessionSourceAdapter } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidCodexSessionId = (id: string): boolean => UUID_RE.test(id);
async function scanCodexSessions(search?: string): Promise<DiscoveredSession[]> {
  const root = codexSessionsRoot();
  if (!existsSync(root)) return [];
  const out: DiscoveredSession[] = [];
  for (const filePath of listCodexSessionFiles(root)) {
    const sessionId = codexSessionIdFromFilename(filePath.split("/").pop() || "");
    if (!sessionId) continue;
    const fileStat = await stat(filePath).catch(() => null); // 扫描期间被删 / 轮转：跳过这一个
    if (!fileStat) continue;
    // cwd 在首行 session_meta 里，而那一行可能有好几 KB（塞着 base_instructions），
    // 必须读完整行再 parse —— 见 codex-session.readCodexMeta
    const meta = await readCodexMeta(filePath);
    if (!meta?.cwd) continue;
    if (search && !`${meta.cwd} ${sessionId}`.toLowerCase().includes(search.toLowerCase())) continue;
    out.push({
      sessionId,
      cwd: meta.cwd,
      slug: meta.cwd.split("/").filter(Boolean).pop() || "",
      modifiedAt: fileStat.mtime,
      lastUserMessage: await lastUserTextOf(filePath, fileStat.size, codexLineToClaudeShape),
      runtime: "codex",
      ...(meta.sub ? { sub: meta.sub } : {}),
      ...(meta.oneShot ? { oneShot: true as const } : {}),
    });
  }
  return out;
}

/** 会话来源部分：只读，与生命周期状态无关 */
export const codexSource: Omit<SessionSourceAdapter, "manageable" | "control"> = {
  id: "codex",
  label: "Codex",
  scanSessions: scanCodexSessions,
  /** 文件名带 ISO 时间戳前缀又按日期分目录，光有 cwd+id 推不出路径 */
  sessionPath: () => null,
  findSessionById: (sessionId) => findCodexSessionPath(sessionId),
  /** rollout 按日期分目录、不按 cwd 分，没有「某目录下的会话文件」这个概念 */
  listSessionsForCwd: () => [],
  ownsPath: (path, home) => isCodexSessionPath(path, home),
  sessionIdFromPath: (path) => codexSessionIdFromFilename(basename(path)),
  /** 归档副本没有路径特征时靠首行：Codex 恒以 session_meta 开头 */
  sniffFirstLine: (rec) => rec?.type === "session_meta",
  translateLine: (line): AnyRecord | null => codexLineToClaudeShape(line),
  /** token 只有累计计数器（token_count.total_token_usage），要按文件顺序做差 */
  scanStatsWindow: scanCodexStatsWindow,
  /**
   * 每文件一份翻译状态：按轮丢 code-mode exec（输出按 call_id 精确丢）、整轮丢 exec 引导。
   * 初始按「本轮已有 item 事件」算——读窗口常从回合中间开始，看不到那轮开头的 UserMessage
   * item；新版 rollout 全带 item 事件，这与无状态近似同口径；老版 rollout 在第一个
   * task_started 之后自然回到「没有 item → 保留 exec」。
   */
  newTranslator() {
    const state = newCodexTranslateState();
    state.turnHasItems = true;
    return (line: string) => codexLineToClaudeShape(line, state);
  },
};
