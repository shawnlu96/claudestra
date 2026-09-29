/**
 * 归档用的 Codex rollout 定位：按 thread id 找到的文件必须真是这个 agent 的，认不准就不归档。
 *
 * findCodexSessionPath 只看文件名、还接受前缀、多份同名按 mtime 取第一个——给列表 / 尾读用够了，归档不行：
 * 同一个 thread id 出现在两份 rollout 里（导入、恢复、手工拷贝），拿错一份就是把别的 agent 的正文拷进这个 agent 的归档。
 * 所以这里只认完整 id，逐份核对首行 session_meta 的 id 与 cwd（registry 条目的工作目录），唯一命中才用；
 * 零份或多份都返回说明、列出候选，由调用方报 ok:false（tests/codex-rollout-pick.test.ts）。
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { codexSessionIdFromFilename, codexSessionsRoot, listCodexSessionFiles, readCodexMetaPayload } from "./codex-session.js";

export type RolloutPick = { path: string } | { error: string };

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
  root: string = codexSessionsRoot(),
): Promise<RolloutPick> {
  const named = listCodexSessionFiles(root).filter((p) => codexSessionIdFromFilename(basename(p)) === sessionId);
  if (named.length === 0) return { error: `Codex 会话记录不存在：${root} 下找不到 thread ${sessionId} 的 rollout` };
  const want = cwd ? canonicalDir(cwd) : null;
  const described: string[] = [];
  const matched: string[] = [];
  for (const p of named) {
    const meta = await readCodexMetaPayload(p);
    const id = String(meta?.id ?? meta?.session_id ?? "");
    const metaCwd = typeof meta?.cwd === "string" ? meta.cwd : "";
    described.push(`${p}（id=${id || "?"}，cwd=${metaCwd || "?"}）`);
    if (id !== sessionId) continue;
    if (want !== null && (!metaCwd || canonicalDir(metaCwd) !== want)) continue;
    matched.push(p);
  }
  if (matched.length === 1) return { path: matched[0]! };
  const expect = `registry 里 thread ${sessionId}、cwd ${cwd ?? "（未记录）"}`;
  if (matched.length === 0) return { error: `Codex rollout 对不上 ${expect}，不归档。候选：${described.join("；")}` };
  return { error: `有 ${matched.length} 份 rollout 都像是 ${expect} 的，分不清是哪一份，不归档。候选：${described.join("；")}` };
}
