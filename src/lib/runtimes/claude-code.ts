/** Claude Code 适配器：路径可预测、行就是最终形状，所以大部分方法是直通。 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findJsonlBySessionId, projectJsonlPath, projectsDir } from "../jsonl-cost.js";
import { lastUserTextOf } from "./shared.js";
import type { AnyRecord, DiscoveredSession, SessionSourceAdapter } from "./types.js";

function claudeProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

export const claudeCodeAdapter: SessionSourceAdapter = {
  id: "claude-code",
  label: "Claude Code",
  manageable: true,

  async scanSessions(search?: string): Promise<DiscoveredSession[]> {
    const root = claudeProjectsRoot();
    if (!existsSync(root)) return [];
    const out: DiscoveredSession[] = [];
    for (const projDir of await readdir(root).catch(() => [] as string[])) {
      const projPath = join(root, projDir);
      const projStat = await stat(projPath).catch(() => null);
      if (!projStat?.isDirectory()) continue;
      for (const file of await readdir(projPath).catch(() => [] as string[])) {
        if (!file.endsWith(".jsonl") || file.includes("compact")) continue;
        const uuid = file.replace(".jsonl", "");
        if (!/^[0-9a-f]{8}-/.test(uuid)) continue;
        const filePath = join(projPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        let sessionId = uuid;
        let cwd = "";
        let slug = "";
        try {
          const chunk = await Bun.file(filePath).slice(0, 8192).text();
          for (const line of chunk.split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.sessionId) sessionId = obj.sessionId;
              if (obj.cwd && !cwd) cwd = obj.cwd;
              if (obj.slug && !slug) slug = obj.slug;
              if (cwd && slug) break;
            } catch { /* 半行/坏行跳过 */ }
          }
        } catch { /* non-critical */ }
        if (!cwd) continue;
        if (search && !`${cwd} ${sessionId}`.toLowerCase().includes(search.toLowerCase())) continue;

        out.push({
          sessionId,
          cwd,
          slug: slug || cwd.split("/").filter(Boolean).pop() || "",
          modifiedAt: fileStat.mtime,
          lastUserMessage: await lastUserTextOf(filePath, fileStat.size, this.translateLine),
          runtime: "claude-code",
        });
      }
    }
    return out;
  },

  sessionPath: (cwd, sessionId) => projectJsonlPath(cwd, sessionId),
  findSessionById: (sessionId) => findJsonlBySessionId(sessionId),

  listSessionsForCwd(cwd) {
    const dir = projectsDir(cwd);
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes("compact"))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  },

  ownsPath: (path, home = homedir()) => path.startsWith(claudeProjectsRoot(home) + "/"),

  /** 行本来就是 Claude Code 形状，原样返回 */
  translateLine(line: string): AnyRecord | null {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" ? (parsed as AnyRecord) : null;
    } catch {
      return null;
    }
  },

};
