/**
 * /sessions/:sid/*（按会话 id 直接读 / 处置会话文件，不经 agent 名）的定位与 master 闸。
 * 这两个端点只有全权门（isFullScope），"*" 又不含 master（CLAUDE.md：* = 全部非大总管）——不单独拦，老 "*" Bearer
 * 拿到 master 的 sessionId 就能读它的完整会话、删它的会话文件。GET /sessions 同理要把 master 的会话滤掉，免得把 id 递出去。
 * 测试见 tests/api-master-scope.test.ts。
 */
import { existsSync, readdirSync, realpathSync } from "fs";
import { dirname, join, relative, sep } from "path";
import { projectsDir, projectsSlug } from "../lib/jsonl-cost.js";
import { agentInScope, isOwnerPrincipal, type Principal } from "../lib/principals.js";
import { isMasterName } from "../lib/registry.js";
import { ARCHIVE_ROOT } from "../lib/session-archive.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";

/** 先按 cwd + runtime 精确推（Pi 文件名带时间戳，光有 id 推不出），再三种 runtime 各自全库兜底；磁盘上没有 → null */
export function locateSessionFile(sid: string, runtime: string | undefined, cwd: string | undefined): string | null {
  const exact = cwd ? sessionJsonlPath(runtime, cwd, sid) : null;
  const file =
    exact && existsSync(exact)
      ? exact
      : (findSessionJsonlBySessionId(runtime ?? "pi", sid) ?? findSessionJsonlBySessionId("claude-code", sid) ?? findSessionJsonlBySessionId("codex", sid));
  return file && existsSync(file) ? file : null;
}

/** 看得见 master 的会话：scope 显式列了 master，或 owner 本人（isOwnerPrincipal） */
export const masterSessionsAllowed = (p: Principal): boolean => agentInScope(p, "master") || isOwnerPrincipal(p);

/** 这个会话文件是不是大总管的：在大总管工作目录对应的 CC 项目目录下，或在归档根下 master 的目录里（任何写法，isMasterName） */
export function isMasterSessionFile(file: string, masterDir: string, archiveRoot: string = ARCHIVE_ROOT): boolean {
  if (dirname(file) === projectsDir(masterDir)) return true;
  const rel = relative(archiveRoot, file);
  return !rel.startsWith("..") && isMasterName(rel.split(sep)[0]);
}

/**
 * registry 里查不到的 agent（被 remove 了，归档还留着）按名字读历史：只认归档根下逐字同名的目录，master 的任何写法都不认，
 * 目录的真实路径也得就是根下这个名字（链接到根外、或到别的 agent 的目录都不认）。不能直接拿请求里的名字拼路径——
 * APFS 不分大小写，agent-Master 会落进 agent-master 的目录。都不中 → null（调用方回 404）。
 */
export function archivedOnlyAgent(param: string, archiveRoot: string = ARCHIVE_ROOT): string | null {
  const canonical = param.startsWith("agent-") ? param : `agent-${param}`;
  if (isMasterName(canonical)) return null;
  try {
    if (!readdirSync(archiveRoot).includes(canonical)) return null;
    return realpathSync(join(archiveRoot, canonical)) === join(realpathSync(archiveRoot), canonical) ? canonical : null;
  } catch {
    return null; // 归档根还没建、悬空链接：没有可读的归档
  }
}

/** 会话的 cwd 是不是大总管的工作目录（按 CC 的 slug 规则比，/tmp 与 /private/tmp 这类链接也算同一个） */
export const isMasterCwd = (cwd: string | undefined, masterDir: string): boolean => !!cwd && projectsSlug(cwd) === projectsSlug(masterDir);
