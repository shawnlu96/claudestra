/** Pi 适配器。文件名带时间戳前缀 ⇒ 路径推不出来，只能扫目录（见各方法注释）。 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  findPiSessionBySessionId,
  listPiSessionJsonls,
  piAgentDir,
  piLineToClaudeShape,
  piSessionIdFromFilename,
  piSessionPath,
} from "../pi-session.js";
import { lastUserTextOf } from "./shared.js";
import type { AnyRecord, DiscoveredSession, SessionSourceAdapter } from "./types.js";

export const piAdapter: SessionSourceAdapter = {
  id: "pi",
  label: "Pi",
  manageable: true,

  async scanSessions(search?: string): Promise<DiscoveredSession[]> {
    const root = join(piAgentDir(), "sessions");
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    for (const dir of await readdir(root).catch(() => [] as string[])) {
      if (!dir.startsWith("--")) continue; // 目录名是 cwd 的编码
      const dirPath = join(root, dir);
      for (const file of await readdir(dirPath).catch(() => [] as string[])) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = piSessionIdFromFilename(file);
        if (!sessionId) continue;
        const filePath = join(dirPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        // cwd 只能从 header 行读（目录编码把 `/` 换成 `-`，不可逆）
        let cwd = "";
        try {
          const head = await Bun.file(filePath).slice(0, 4096).text();
          for (const line of head.split("\n")) {
            if (!line.includes('"cwd"')) continue;
            const obj = JSON.parse(line);
            if (obj?.type === "session" && typeof obj.cwd === "string") { cwd = obj.cwd; break; }
          }
        } catch { /* non-critical */ }
        if (!cwd) continue;
        if (search && !`${cwd} ${sessionId}`.toLowerCase().includes(search.toLowerCase())) continue;

        out.push({
          sessionId,
          cwd,
          slug: cwd.split("/").filter(Boolean).pop() || "",
          modifiedAt: fileStat.mtime,
          lastUserMessage: await lastUserTextOf(filePath, fileStat.size, piLineToClaudeShape),
          runtime: "pi",
        });
      }
    }
    return out;
  },

  sessionPath: (cwd, sessionId) => piSessionPath(cwd, sessionId),
  findSessionById: (sessionId) => findPiSessionBySessionId(sessionId),
  listSessionsForCwd: (cwd) => listPiSessionJsonls(cwd),
  ownsPath: (path) => path.includes(`${piAgentDir()}/sessions/`),
  /** Pi 的首行恒为 `{type:"session", version:<number>}` */
  sniffFirstLine: (rec) => rec?.type === "session" && typeof rec?.version === "number",
  translateLine: (line): AnyRecord | null => piLineToClaudeShape(line),
};
