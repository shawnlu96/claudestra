/** OpenCode 的只读会话来源：库在 SQLite 里，按需导出成状态目录下的镜像 JSONL 再走通用的逐行读（lib/opencode-session.ts）。 */
import {
  isOpencodeMirrorPath,
  isOpencodeMirrorRecord,
  isValidOpencodeSessionId,
  opencodeLineToClaudeShape,
  opencodeSessionIdFromPath,
  opencodeMirrorPathNow,
  scanOpencodeSessions,
} from "../opencode-session.js";
import type { AnyRecord, SessionSourceAdapter } from "./types.js";

export const opencodeSource: Omit<SessionSourceAdapter, "manageable" | "control"> = {
  id: "opencode",
  label: "OpenCode",
  scanSessions: (search) => scanOpencodeSessions(search),
  /** 会话不按 cwd 落文件：cwd 用不上，按 id 拿镜像（不等导出，过期后台刷；bridge 会周期性要路径，不能同步导出卡住它） */
  sessionPath: (_cwd, sessionId) => opencodeMirrorPathNow(sessionId),
  findSessionById: (sessionId) => opencodeMirrorPathNow(sessionId),
  /** 库里的会话不是文件，没有「某目录下的会话文件」这个概念 */
  listSessionsForCwd: () => [],
  ownsPath: (path) => isOpencodeMirrorPath(path),
  sessionIdFromPath: opencodeSessionIdFromPath,
  ownsSessionId: isValidOpencodeSessionId,
  sniffFirstLine: (rec) => isOpencodeMirrorRecord(rec),
  translateLine: (line): AnyRecord | null => opencodeLineToClaudeShape(line),
};
