/**
 * 归档用的 Codex rollout 定位：按 thread id 找到的文件必须真是这个 agent 的，认不准就不归档。
 *
 * findCodexSessionPath 只看文件名、还接受前缀、多份同名按 mtime 取第一个——给列表 / 尾读用够了，归档不行：
 * 同一个 thread id 出现在两份 rollout 里（导入、恢复、手工拷贝），拿错一份就是把别的 agent 的正文拷进这个 agent 的归档。
 * 所以这里只认完整 id、核对首行 session_meta 的 id；同一段（rolloutId）首行 id 对得上的只有一份就用它（cwd 不同只记进 note：
 * resume 换了目录，registry cwd 会变、rollout 首行不会）。多份时才拿 registry cwd 区分，还分不开就拒（tests/codex-rollout-pick.test.ts）。
 *
 * revert 链：Codex `thread/revert` 保留 thread id、另起 `<threadId>_<rolloutId>.jsonl`，新文件**只装新条目**，
 * 首行 history_base.thread_id 记着前一段的 rolloutId。只拷最新一段会丢前缀、只拷原文件会丢新正文，所以整条链每段各存一份（按 rolloutId 命名）；
 * Codex 按文件 mtime 满 7 天把段压成 `.jsonl.zst`：压过的段同明文段一样认（流式只解首行）、一样拷（copyIfLarger 流式解压落盘），同一段明文和 .zst 都在时用明文。
 * 本线程有段没存上（解压失败 / 首行坏 / 链上引用落空）→ incomplete，调用方报 ok:false。
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { codexSessionsRoot, listCodexSessionFiles, readCodexMetaPayload } from "./codex-session.js";
import { sandboxCodexHomeProblem } from "./sandbox.js";
import { readZstdFirstLine } from "./zstd-file.js";

/**
 * 一段 rollout 及它在归档里的文件名（不带 .jsonl）：原文件是 thread id，revert 段是它自己的 rolloutId（UUIDv7，不会撞）。
 * 不用 `<threadId>_<rolloutId>`：历史 API 的 sessionId 白名单（session-history.ts SESSION_ID_RE）不收下划线、限 64 字符，列得出来却打不开。
 */
type RolloutSegment = { path: string; stem: string };
export type RolloutPick = { segments: RolloutSegment[]; note?: string; incomplete?: string } | { error: string };

/** rollout 文件名拆出的三段：stamp 是文件名里的时间（到秒），rolloutId 在普通文件里等于 threadId */
interface CodexRolloutName {
  stamp: string;
  threadId: string;
  rolloutId: string;
  compressed: boolean;
}

/** 两种文件名都认（外加 Codex 压缩后的 `.jsonl.zst`）。列表 / 尾读 / 用量不用它：放宽那边会让同一线程出两条、用量重复计 */
function parseCodexRolloutFilename(name: string): CodexRolloutName | null {
  const m = /^rollout-(\d{4}-\d{2}-\d{2}T[\d-]+)-([0-9a-fA-F-]{36})(?:_([0-9a-fA-F-]{36}))?\.jsonl(\.zst)?$/.exec(name);
  return m ? { stamp: m[1]!, threadId: m[2]!, rolloutId: m[3] ?? m[2]!, compressed: !!m[4] } : null;
}

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

type Named = { path: string; name: CodexRolloutName };
type Candidate = Named & { cwd: string; base: string | null };

/** 链序：文件名时间，同一秒再比 UUIDv7 的 rolloutId——与 Codex 自己按 thread id 找最新文件的规则一致（list.rs），不看 mtime */
const chainOrder = (a: Named, b: Named) =>
  a.name.stamp.localeCompare(b.name.stamp) || a.name.rolloutId.toLowerCase().localeCompare(b.name.rolloutId.toLowerCase());

const metaId = (meta: Record<string, any> | null) => String(meta?.id ?? meta?.session_id ?? "");

/** 首行 session_meta.payload；.zst 流式解到首行为止（与明文同样封顶 4MB），解压失败返回原因 */
async function readSegmentMeta(f: Named): Promise<{ meta: Record<string, any> | null } | { error: string }> {
  if (!f.name.compressed) return { meta: await readCodexMetaPayload(f.path) };
  const head = await readZstdFirstLine(f.path, 4 * 1024 * 1024);
  if (head.kind === "error") return { error: `.zst 解压失败：${head.message}` };
  if (head.kind === "too-long") return { meta: null };
  try {
    const obj = JSON.parse(head.text);
    return { meta: obj?.type === "session_meta" ? (obj?.payload ?? {}) : null };
  } catch {
    return { meta: null }; // 首行坏：同明文段，当首行读不出
  }
}

export async function pickCodexRolloutForArchive(
  sessionId: string,
  cwd: string | undefined,
  root: string = codexSessionsRoot(),
): Promise<RolloutPick> {
  if (sandboxCodexHomeProblem()) return { error: sandboxCodexHomeProblem()! }; // 沙箱 CODEX_HOME 不安全：不回落宿主 ~/.codex；归档不抛错，按 ok:false 报
  const all = listCodexSessionFiles(root, (n) => parseCodexRolloutFilename(n) !== null)
    .map((path) => ({ path, name: parseCodexRolloutFilename(basename(path))! }));
  const mine = all.filter((f) => f.name.threadId === sessionId);
  if (mine.length === 0) return { error: `Codex 会话记录不存在：${root} 下找不到 thread ${sessionId} 的 rollout` };
  const want = cwd ? canonicalDir(cwd) : null;
  const described: string[] = [];
  const idOk: Candidate[] = [];
  const skipped = new Map<string, string>(); // 文件名是本线程、首行却认不了的段 → 原因（chainGaps 报缺口用）
  for (const f of mine) {
    const read = await readSegmentMeta(f);
    if ("error" in read) {
      described.push(`${f.path}（${read.error}）`);
      skipped.set(f.path, read.error);
      continue;
    }
    const meta = read.meta;
    const id = metaId(meta);
    const metaCwd = typeof meta?.cwd === "string" ? meta.cwd : "";
    described.push(`${f.path}（id=${id || "?"}，cwd=${metaCwd || "?"}）`);
    const base = meta?.history_base?.thread_id;
    if (id === sessionId) idOk.push({ ...f, cwd: metaCwd, base: typeof base === "string" && base ? base : null });
    else skipped.set(f.path, meta ? `首行 id 是 ${id || "?"}` : "首行读不出");
  }
  const expect = `registry 里 thread ${sessionId}、cwd ${cwd ?? "（未记录）"}`;
  if (idOk.length === 0) return { error: `Codex rollout 首行 id 都对不上 ${expect}，不归档。候选：${described.join("；")}` };
  const sameDir = (c: string) => want !== null && !!c && canonicalDir(c) === want;

  const chosen: Candidate[] = [];
  for (const rid of new Set(idOk.map((c) => c.name.rolloutId))) {
    const same = idOk.filter((c) => c.name.rolloutId === rid);
    // 压缩中途崩溃会留下同一段的明文 + .zst：明文是原件（.zst 可能是半截），不算两份
    const group = same.some((c) => !c.name.compressed) ? same.filter((c) => !c.name.compressed) : same;
    const inDir = group.filter((c) => sameDir(c.cwd));
    const pick = group.length === 1 ? group[0] : inDir.length === 1 ? inDir[0] : undefined;
    if (!pick) {
      return { error: `有 ${group.length} 份 rollout 都是 thread ${sessionId}，按 cwd ${cwd ?? "（未记录）"} 也分不清是哪一份，不归档。候选：${described.join("；")}` };
    }
    chosen.push(pick);
  }
  chosen.sort(chainOrder);

  const notes: string[] = [];
  const drift = chosen.filter((c) => want !== null && !sameDir(c.cwd));
  if (drift.length) {
    const cwds = [...new Set(drift.map((c) => c.cwd || "?"))].join("、");
    notes.push(`rollout 记的 cwd 是 ${cwds}，与 ${expect} 不同（多半是换目录 resume）；id 唯一，照常归档`);
  }
  if (chosen.length > 1) notes.push(`Codex revert 链 ${chosen.length} 段，每段各存一份，最新 ${basename(chosen[chosen.length - 1]!.path)}`);
  const incomplete = chainGaps({ chosen, all, mine, skipped, sessionId, notes });
  return {
    segments: chosen.map((c) => ({ path: c.path, stem: c.name.rolloutId })),
    ...(notes.length ? { note: notes.join("；") } : {}),
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * 归档缺什么，任一出现就返回说明（调用方报 ok:false，能拷的段照拷）：
 *   1. 文件名是本线程、却没进 chosen 的段（首行读不出 / 首行 id 不符 / .zst 解压失败，最新段或回退后被放弃的中间段）——不报就是 ok:true 只存旧正文
 *   2. 已选段的 history_base 指向的同线程段找不到
 * 前缀在别的线程（分页 fork 的父线程）只记 note；原文件（rolloutId = threadId）的 history_base 只可能指向父线程，找不到也按 fork 记 note。
 */
function chainGaps(ctx: {
  chosen: Candidate[];
  all: Named[];
  mine: Named[];
  skipped: Map<string, string>;
  sessionId: string;
  notes: string[];
}): string | null {
  const { chosen, all, mine, skipped, sessionId, notes } = ctx;
  const have = new Set(chosen.map((c) => c.name.rolloutId));
  const latest = [...mine].sort(chainOrder).at(-1)!.name.rolloutId;
  const missing: string[] = [];
  for (const rid of new Set(mine.map((f) => f.name.rolloutId))) {
    if (have.has(rid)) continue;
    const why = mine.filter((f) => f.name.rolloutId === rid).map((f) => `${basename(f.path)}：${skipped.get(f.path) ?? "?"}`);
    missing.push(`${rid === latest ? "最新段" : "段"} ${rid} 没归档（${why.join("；")}）`);
  }
  for (const c of chosen) {
    if (!c.base || have.has(c.base)) continue;
    const ref = all.filter((f) => f.name.rolloutId === c.base);
    const foreign = ref.find((f) => f.name.threadId !== sessionId);
    if (foreign) {
      notes.push(`${basename(c.path)} 的前缀在父线程 ${foreign.name.threadId} 的 rollout 里，随父线程归档，这里不拷`);
    } else if (!ref.length && c.name.rolloutId === c.name.threadId) {
      notes.push(`${basename(c.path)} 的前缀 ${c.base} 属于父线程（fork），本机已找不到，不算本线程缺段`);
    } else if (!ref.length) {
      missing.push(`${basename(c.path)} 的前一段 ${c.base}（找不到文件）`);
    } // ref 是本线程的段：上面一轮已按「没进 chosen」报过
  }
  return missing.length ? `revert 链缺段：${missing.join("；")}` : null;
}
