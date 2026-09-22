/**
 * Codex 适配器（v2.24+）。
 *
 * `manageable: false` —— 目前只读。**不是做不到**：`codex queue --thread --message`
 * 实测能往运行中的会话注消息、`codex mcp add` 能挂我们的工具、交互式会话写的是同一
 * 份 rollout（2026-09-22 实测三条全通）。只是启动器 / 就绪判据 / 投递接线还没写，
 * 在写完之前这里如实报 false，前端据此不给「收编」按钮。
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  codexLineToClaudeShape,
  codexSessionIdFromFilename,
  codexSessionsRoot,
  findCodexSessionPath,
  isCodexSessionPath,
  listCodexSessionFiles,
  readCodexMeta,
} from "../codex-session.js";
import { basename } from "node:path";
import { lastUserTextOf } from "./shared.js";
import type { AnyRecord, DiscoveredSession, RuntimeControl, SessionSourceAdapter } from "./types.js";

/**
 * 先把 bridge 侧的约束声明好（生命周期接线是后续的事）：
 * - 空闲的 Codex 收到一次 C-c 会在 0.8s 内直接退出（2026-09-23 实测），打断只能发 Esc
 * - `codex queue` 对忙着的线程是排到下一轮（不插进当前回合），不需要也不该抢占
 */
export const CODEX_CONTROL: RuntimeControl = {
  interruptKeys: ["Escape"],
  preemptOnHumanMessage: false,
  idleSource: "hook",
  modelEnforcement: "launch-flag",
  paneHeuristics: false,
};

export const codexAdapter: SessionSourceAdapter = {
  id: "codex",
  label: "Codex",
  manageable: false,
  control: CODEX_CONTROL,

  async scanSessions(search?: string): Promise<DiscoveredSession[]> {
    const root = codexSessionsRoot();
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    for (const filePath of listCodexSessionFiles(root)) {
      const sessionId = codexSessionIdFromFilename(filePath.split("/").pop() || "");
      if (!sessionId) continue;
      const fileStat = await stat(filePath).catch(() => null);
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
      });
    }
    return out;
  },

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
};
