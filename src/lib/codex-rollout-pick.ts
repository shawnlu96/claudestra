/**
 * 归档用的 Codex rollout 定位：按 thread id 找到的文件必须真是这个 agent 的，认不准就不归档。
 *
 * findCodexSessionPath 只看文件名、还接受前缀、多份同名按 mtime 取第一个——给列表 / 尾读用够了，归档不行：
 * 同一个 thread id 出现在两份 rollout 里（导入、恢复、手工拷贝），拿错一份就是把别的 agent 的正文拷进这个 agent 的归档。
 * 所以这里只认完整 id、核对首行 session_meta 的 id；首行 id 对得上的只有一份就用它（cwd 不同只记进 note：
 * resume 换了目录，registry cwd 会变、rollout 首行不会）。多份时才拿 registry cwd 区分，还分不开就拒，
 * 列出候选由调用方报 ok:false（tests/codex-rollout-pick.test.ts）。
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { codexSessionIdFromFilename, codexSessionsRoot, listCodexSessionFiles, readCodexMetaPayload } from "./codex-session.js";
import { sandboxCodexHomeProblem } from "./sandbox.js";

export type RolloutPick = { path: string; note?: string } | { error: string };

/** 比较用的目录形态：解开符号链接（macOS 的 /tmp → /private/tmp，Codex 记的是 getcwd 的结果），去掉末尾斜杠 */
function canonicalDir(dir: string): string {
  let d = dir;
  try {
    d = realpathSync(dir);
  } catch {
    /* 目录已经删了：按字面比，删掉的目录两边写法通常一致 */
  }
  return d.length > 1 ? d.replace(/\/+$/, "") : d;
}

export async function pickCodexRolloutForArchive(
  sessionId: string,
  cwd: string | undefined,
  root?: string,
): Promise<RolloutPick> {
  // 沙箱里 CODEX_HOME 不安全就不找（不回落宿主 ~/.codex）；归档契约是不抛错，按 ok:false 报原因（ops-deps 会记日志）
  if (root === undefined) {
    const refused = sandboxCodexHomeProblem();
    if (refused) return { error: refused };
    root = codexSessionsRoot();
  }
  const named = listCodexSessionFiles(root).filter((p) => codexSessionIdFromFilename(basename(p)) === sessionId);
  if (named.length === 0) return { error: `Codex 会话记录不存在：${root} 下找不到 thread ${sessionId} 的 rollout` };
  const want = cwd ? canonicalDir(cwd) : null;
  const described: string[] = [];
  const idOk: Array<{ path: string; cwd: string }> = [];
  for (const p of named) {
    const meta = await readCodexMetaPayload(p);
    const id = String(meta?.id ?? meta?.session_id ?? "");
    const metaCwd = typeof meta?.cwd === "string" ? meta.cwd : "";
    described.push(`${p}（id=${id || "?"}，cwd=${metaCwd || "?"}）`);
    if (id === sessionId) idOk.push({ path: p, cwd: metaCwd });
  }
  const sameDir = (c: string) => want !== null && !!c && canonicalDir(c) === want;
  const expect = `registry 里 thread ${sessionId}、cwd ${cwd ?? "（未记录）"}`;
  if (idOk.length === 1) {
    const only = idOk[0]!;
    if (want === null || sameDir(only.cwd)) return { path: only.path };
    return { path: only.path, note: `rollout 记的 cwd 是 ${only.cwd || "?"}，与 ${expect} 不同（多半是换目录 resume）；id 唯一，照常归档` };
  }
  if (idOk.length === 0) return { error: `Codex rollout 首行 id 都对不上 ${expect}，不归档。候选：${described.join("；")}` };
  const matched = idOk.filter((c) => sameDir(c.cwd));
  if (matched.length === 1) return { path: matched[0]!.path };
  return { error: `有 ${idOk.length} 份 rollout 都是 thread ${sessionId}，按 cwd ${cwd ?? "（未记录）"} 也分不清是哪一份，不归档。候选：${described.join("；")}` };
}
