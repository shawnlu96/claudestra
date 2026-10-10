/**
 * 归档用的 Codex rollout 定位：按 thread id 找到的文件必须真是这个 agent 的，认不准就不归档。
 *
 * findCodexSessionPath 只看文件名、还接受前缀、多份同名按 mtime 取第一个——给列表 / 尾读用够了，归档不行：
 * 同一个 thread id 出现在两份 rollout 里（导入、恢复、手工拷贝），拿错一份就是把别的 agent 的正文拷进这个 agent 的归档。
 * 所以这里只认完整 id、核对首行 session_meta 的 id；首行 id 对得上的只有一份就用它（cwd 不同只记进 note：
 * resume 换了目录，registry cwd 会变、rollout 首行不会）。多份时才拿 registry cwd 区分，还分不开就拒，
 * 列出候选由调用方报 ok:false（tests/codex-rollout-pick.test.ts）。
 */
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { codexSessionIdFromFilename, codexSessionsRoot, listCodexSessionFiles, readCodexMetaPayload } from "./codex-session.js";
import { sandboxCodexHomeProblem } from "./sandbox.js";

export type RolloutPick = { path: string; note?: string } | { error: string };

/**
 * 比较用的目录形态：解开符号链接（macOS 的 /tmp → /private/tmp，Codex 记的是 getcwd 的结果），去掉末尾斜杠。
 * 必须实时解、不走 realpath-cache：这是在判「这份正文归谁」，软链改过指向还按缓存的旧指向比就会认错人；异步，不卡主线程。
 * 目录已删（ENOENT / ENOTDIR）按字面比，删掉的目录两边写法通常一致；其它失败（无权限、TCC 超时）返回 null = 认不准。
 */
async function canonicalDir(dir: string): Promise<string | null> {
  let d = dir;
  try {
    d = await realpath(dir);
  } catch (e) {
    if (!["ENOENT", "ENOTDIR"].includes(String((e as NodeJS.ErrnoException).code))) return null;
  }
  return d.length > 1 ? d.replace(/\/+$/, "") : d;
}

export async function pickCodexRolloutForArchive(
  sessionId: string,
  cwd: string | undefined,
  root: string = codexSessionsRoot(),
): Promise<RolloutPick> {
  if (sandboxCodexHomeProblem()) return { error: sandboxCodexHomeProblem()! }; // 沙箱 CODEX_HOME 不安全：不回落宿主 ~/.codex；归档不抛错，按 ok:false 报
  const named = listCodexSessionFiles(root).filter((p) => codexSessionIdFromFilename(basename(p)) === sessionId);
  if (named.length === 0) return { error: `Codex 会话记录不存在：${root} 下找不到 thread ${sessionId} 的 rollout` };
  const want = cwd ? await canonicalDir(cwd) : undefined; // undefined = registry 没记；null = 记了但现在解不开
  const described: string[] = [];
  const idOk: Array<{ path: string; cwd: string }> = [];
  for (const p of named) {
    const meta = await readCodexMetaPayload(p);
    const id = String(meta?.id ?? meta?.session_id ?? "");
    const metaCwd = typeof meta?.cwd === "string" ? meta.cwd : "";
    described.push(`${p}（id=${id || "?"}，cwd=${metaCwd || "?"}）`);
    if (id === sessionId) idOk.push({ path: p, cwd: metaCwd });
  }
  const expect = `registry 里 thread ${sessionId}、cwd ${cwd ?? "（未记录）"}`;
  if (idOk.length === 1) {
    const only = idOk[0]!;
    if (want === undefined || (want !== null && only.cwd && (await canonicalDir(only.cwd)) === want)) return { path: only.path };
    return { path: only.path, note: `rollout 记的 cwd 是 ${only.cwd || "?"}，与 ${expect} 不同或核对不了（多半是换目录 resume）；id 唯一，照常归档` };
  }
  if (idOk.length === 0) return { error: `Codex rollout 首行 id 都对不上 ${expect}，不归档。候选：${described.join("；")}` };
  const many = `有 ${idOk.length} 份 rollout 都是 thread ${sessionId}`;
  const dirs = want ? await Promise.all(idOk.map((c) => (c.cwd ? canonicalDir(c.cwd) : ""))) : [];
  if (want === null || dirs.includes(null)) {
    return { error: `${many}，但 registry cwd 或候选记的 cwd 现在解不开（无权限 / 超时），认不准是哪一份，不归档。候选：${described.join("；")}` };
  }
  const matched = idOk.filter((_, i) => want !== undefined && dirs[i] === want);
  if (matched.length === 1) return { path: matched[0]!.path };
  return { error: `${many}，按 cwd ${cwd ?? "（未记录）"} 也分不清是哪一份，不归档。候选：${described.join("；")}` };
}
