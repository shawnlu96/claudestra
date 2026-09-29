/**
 * /sessions/:sid/*（按会话 id 直接读 / 处置会话文件，不经 agent 名）的定位与 master 闸。
 * 这两个端点只有全权门（isFullScope），"*" 又不含 master（CLAUDE.md：* = 全部非大总管）——不单独拦，老 "*" Bearer
 * 拿到 master 的 sessionId 就能读它的完整会话、删它的会话文件。GET /sessions 同理要把 master 的会话滤掉，免得把 id 递出去。
 * 测试见 tests/api-master-scope.test.ts。
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { projectsDir, projectsSlug } from "../lib/jsonl-cost.js";
import { agentInScope, type Principal } from "../lib/principals.js";
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

/**
 * 看得见 / 动得了 master 的会话：只看凭据生效后的 scope 里有没有 master（agentInScope 用的是 grant 交集后的 agents），和 cron 同一口径。
 * 不因 owner 本人放行：grant 只给 ["*"] 的 owner 设备就是特意不让碰大总管的（reviews/T32-adv6.md P2-1）。
 */
export const masterSessionsAllowed = (p: Principal): boolean => agentInScope(p, "master");

/**
 * 这个会话文件是不是大总管的（任一条成立）：在大总管工作目录或它的 worktree（EnterWorktree 会把会话挪过去，HF182-r2 P2-B）
 * 对应的 CC 项目目录下；文件开头记录的 cwd 是大总管的（挪到哪都带着）；在归档根下 master 的目录里（任何写法，isMasterName）。
 */
function isMasterSessionFile(file: string, masterDir: string, archiveRoot: string = ARCHIVE_ROOT): boolean {
  const dir = dirname(file);
  if (dir === projectsDir(masterDir) || basename(dir).startsWith(`${projectsSlug(masterDir)}--claude-worktrees-`)) return true;
  if (isMasterCwd(firstRecordedCwd(file), masterDir)) return true;
  const rel = relative(archiveRoot, file);
  return !rel.startsWith("..") && isMasterName(rel.split(sep)[0]);
}

/** 按会话 id 动大总管的会话（读、删、收编、接管、分叉）要 masterSessionsAllowed；file 为 null（不在磁盘上）交给调用方 */
export const masterSessionHidden = (p: Principal, file: string | null, masterDir: string): boolean =>
  !!file && isMasterSessionFile(file, masterDir) && !masterSessionsAllowed(p);

/** 会话文件开头 64KB 里第一条带 cwd 的记录（CC 每条都带；Codex 在 session_meta.payload 里）；读不到 → undefined */
function firstRecordedCwd(file: string): string | undefined {
  const buf = Buffer.alloc(65536);
  let n = 0;
  try {
    const fd = openSync(file, "r");
    try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  } catch {
    return undefined; // 读不了就只按目录判：调用方前面已确认文件存在，这里失败多半是权限，按不是大总管处理与旧口径一致
  }
  for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const o = JSON.parse(line);
      const cwd = o?.cwd ?? o?.payload?.cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch { /* 被 64KB 截断的最后一行、非 JSON 行：跳过，看下一行 */ }
  }
  return undefined;
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

/** 会话的 cwd 是不是大总管的工作目录或它的 worktree（<MASTER_DIR>/.claude/worktrees/*；按 CC 的 slug 规则比，/tmp 与 /private/tmp 算同一个） */
export function isMasterCwd(cwd: string | undefined, masterDir: string): boolean {
  if (!cwd) return false;
  const slug = projectsSlug(cwd), master = projectsSlug(masterDir);
  return slug === master || slug.startsWith(`${master}--claude-worktrees-`);
}
