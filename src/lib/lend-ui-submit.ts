/**
 * LENDUI2：出借 worker 交写单时一并交截图（`lend submit <单号> ... --ui-shots-file <副本内路径>`），只由 manager/lend-submit.ts 引入，调度够不到。
 * 清单文件 `{v: 1, summary, shots: [{view, size, phase, file}]}`（封闭），file 是和清单同目录的裸文件名。逐张按 readReportIn 的规则读
 * （副本内、不跟软链、nlink 1、普通文件、打开后再核 inode、≤ 1 MiB），过 checkShotPng（只收 PNG、去元数据），再去掉 iCCP（ICC 配置名可能带设备名）；
 * 成对 / 重复 / 张数 / summary 的规则全交给 parseUiEvidence（用文件名当占位 ref 拼一份试算清单），不另写一份。
 * 隐私：summary / view 里不许有绝对路径片段、本机 HOME / LEND_ROOT / 副本路径、本机用户名 / 主机名，命中只说哪一类、不回显原文；
 * PNG 宽度必须是 size 宽度的 1 / 2 / 3 倍（挡整屏截图）。有一条不过就拒交、什么都不拷贝、journal 不动。
 * 都过了才把去过元数据的字节写到 <工作副本>/.git/lend-ui-shots/<sha256>.png（0600，目录 0700、每层是真目录），再交给 submitLendWork 记进 work.ui。
 * 开关 lendUiUpload 是 off：参数照收、图不读，代码照交，只回一句提示。tests/lend-ui-submit.test.ts。
 */
import type { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { LEND_ROOT } from "./lend-clone.js";
import { getOrder, orderOf, type WorkUi, type WorkUiShot } from "./lend-journal.js";
import { lendUiUploadMode } from "./lend-key-mode.js";
import { readBytesIn, submitLendWork, type SubmitOutcome, type SubmitterDeps, type WorkInput } from "./lend-submit.js";
import { sha256Hex, UI_COPY_DIR, uiCopyPath, uiShotOrder } from "./lend-ui-send.js";
import { checkShotPng, LEND_SHOT_LIMITS } from "./lend-ui-wire.js";
import { isUiEvidenceError, parseUiEvidence, uiEvidenceDigest, type UiPhase } from "./order-deliver-ui.js";
import type { RecoveryMode } from "./recovery-policy.js";
import { writeTextAtomicSync } from "./state-file.js";

const MANIFEST_MAX = 64 * 1024;
const FILE = /^[\w.-]{1,100}\.png$/;
export const UI_OFF_NOTE = "本机没开截图回传，截图不交，代码照交";

/** 隐私文字检查要比对的本机事实（单测注入；生产取本机） */
export interface PrivacyFacts { home: string; lendRoot: string; copy: string; user: string; host: string }
export interface UiSubmitOpts { mode?: () => RecoveryMode; privacy?: Partial<PrivacyFacts> }
interface OrderFacts { taskId: string; head: string; specRev: number; round: number }
interface Listed { view: string; size: string; phase: UiPhase; file: string }
type Fail = { ok: false; error: string };

/** 封闭解析清单：多键少键、file 不是裸文件名都拒；view / size / summary 的规则留给 parseUiEvidence */
function parseList(text: string): { ok: true; summary: string; shots: Listed[] } | Fail {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "截图清单要是 JSON 对象" }; }
  const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => k in (v as object));
  if (!exact(raw, ["v", "summary", "shots"]) || raw.v !== 1 || typeof raw.summary !== "string" || !Array.isArray(raw.shots)) {
    return { ok: false, error: "截图清单只认 {v: 1, summary, shots: [{view, size, phase, file}]}" };
  }
  const shots: Listed[] = [];
  for (const [i, s] of (raw.shots as unknown[]).entries()) {
    if (!exact(s, ["view", "size", "phase", "file"]) || typeof s.view !== "string" || typeof s.size !== "string" || (s.phase !== "before" && s.phase !== "after")) {
      return { ok: false, error: `截图清单 shots[${i}] 只认 {view, size, phase: before|after, file}` };
    }
    if (typeof s.file !== "string" || !FILE.test(s.file)) return { ok: false, error: `截图清单 shots[${i}].file 要是和清单同目录的裸文件名（[\\w.-]，.png 结尾，不带斜杠）` };
    shots.push({ view: s.view, size: s.size, phase: s.phase, file: s.file });
  }
  return { ok: true, summary: raw.summary, shots };
}

const ABS = [/\/Users\//, /\/home\//, /\/private\//, /\/var\/folders\//, /\/tmp\//, /~\//, /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/];

/** summary / view 里带了本机的东西：返回命中的类别（不回显原文），没有 = null */
function privacyHit(texts: string[], f: PrivacyFacts): string | null {
  const t = texts.join("\n");
  if (ABS.some((re) => re.test(t))) return "绝对路径片段";
  if ([f.home, f.lendRoot, f.copy].some((p) => p.length >= 3 && t.includes(p))) return "本机目录（HOME / LEND_ROOT / 副本路径）";
  const lower = t.toLowerCase();
  const names = [f.user, f.host, f.host.split(".")[0] ?? ""].filter((n) => n.length >= 3).map((n) => n.toLowerCase());
  if (names.some((n) => lower.includes(n))) return "本机用户名或主机名";
  return null;
}

/** 去掉 iCCP 块（stripImageMeta 白名单保留它；B 侧另删）：输入已是 checkShotPng 走通过的 PNG */
export function dropIccp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (let at = 8; at + 12 <= b.length;) {
    const end = at + 12 + view.getUint32(at);
    if (String.fromCharCode(...b.subarray(at + 4, at + 8)) !== "iCCP") parts.push(b.subarray(at, end));
    at = end;
  }
  return Buffer.concat(parts);
}

/** 用文件名当占位 ref 拼一份试算清单过 parseUiEvidence：成对、重复、张数、summary 全靠它 */
function trial(o: OrderFacts, summary: string, shots: (Listed & { sha256: string })[]): string | null {
  const e = { v: 1 as const, taskId: o.taskId, head: o.head, specRev: o.specRev, round: o.round + 1, source: "imported" as const, summary,
    shots: shots.map((s) => ({ view: s.view, size: s.size, phase: s.phase, ref: s.file, sha256: s.sha256 })) };
  try { parseUiEvidence({ ...e, digest: uiEvidenceDigest(e) }); return null; } catch (err) {
    if (isUiEvidenceError(err)) return `截图清单不合格：${(err as Error).message}`;
    throw err;
  }
}

export type UiPrepared = { ok: true; ui: WorkUi; copies: { sha256: string; data: Uint8Array }[] } | Fail;

/** 读清单与图、全部自检；什么都不写 */
export function prepareUiShots(dir: string, manifestPath: string, order: OrderFacts, privacy: PrivacyFacts): UiPrepared {
  const m = readBytesIn(dir, manifestPath, { max: MANIFEST_MAX, what: "截图清单", field: "--ui-shots-file" });
  if (!m.ok) return m;
  const list = parseList(Buffer.from(m.bytes).toString("utf8"));
  if (!list.ok) return list;
  const hit = privacyHit([list.summary, ...list.shots.map((s) => s.view)], privacy);
  if (hit) return { ok: false, error: `截图清单的 summary / view 里有${hit}，不收（不回显原文）；改成不带本机信息的说法再交` };
  const placeholder = trial(order, list.summary, list.shots.map((s) => ({ ...s, sha256: sha256Hex(Buffer.from(s.file)) })));
  if (placeholder) return { ok: false, error: placeholder }; // 先按结构核一遍，再读图
  const shots: (WorkUiShot & { file: string })[] = [];
  const copies: { sha256: string; data: Uint8Array }[] = [];
  for (const s of list.shots) {
    const r = readBytesIn(dir, join(dirname(manifestPath), s.file), { max: LEND_SHOT_LIMITS.png, what: `截图 ${s.file}`, field: "file" });
    if (!r.ok) return r;
    const png = checkShotPng(r.bytes);
    if (!png.ok) return { ok: false, error: `截图 ${s.file} 不收：${png.error}` };
    const w = Number(s.size.split("x")[0]);
    if (![1, 2, 3].some((k) => png.width === w * k)) return { ok: false, error: `截图 ${s.file} 宽 ${png.width}，不是 ${s.size} 宽度的 1 / 2 / 3 倍（只截页面本身，不截整屏）` };
    const data = dropIccp(png.data), sha256 = sha256Hex(data);
    shots.push({ view: s.view, size: s.size, phase: s.phase, sha256, bytes: data.length, width: png.width, height: png.height, file: s.file });
    copies.push({ sha256, data });
  }
  const bad = trial(order, list.summary, shots);
  if (bad) return { ok: false, error: bad };
  return { ok: true, ui: { summary: list.summary, shots: shots.map(({ file: _f, ...rest }) => rest).sort(uiShotOrder) }, copies };
}

/** 拷贝写进 <副本>/.git/lend-ui-shots/：.git 与 lend-ui-shots 都要是真目录（不是软链），目录 0700、文件 0600、不跟软链；返回问题，null = 写好了 */
export function storeUiCopies(dir: string, copies: { sha256: string; data: Uint8Array }[]): string | null {
  const git = join(dir, ".git"), shots = join(git, UI_COPY_DIR);
  const realDir = (p: string) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
  try {
    if (!realDir(git)) return "工作副本的 .git 不是普通目录，截图拷贝不写";
    if (!lstatOrNull(shots)) mkdirSync(shots, { mode: 0o700 });
    if (!realDir(shots)) return `.git/${UI_COPY_DIR} 不是普通目录，截图拷贝不写`;
    chmodSync(shots, 0o700);
    for (const c of copies) writeTextAtomicSync(uiCopyPath(dir, c.sha256), c.data, { noFollow: true, mode: 0o600 });
    return null;
  } catch (e) { return `写截图拷贝失败：${(e as NodeJS.ErrnoException).code ?? "io"}`; }
}
const lstatOrNull = (p: string) => { try { return lstatSync(p); } catch { return null; } };

const localFacts = (copy: string, over: Partial<PrivacyFacts> = {}): PrivacyFacts =>
  ({ home: homedir(), lendRoot: LEND_ROOT, copy, user: (() => { try { return userInfo().username; } catch { return ""; } })(), host: hostname(), ...over });

/**
 * 写单交活带截图：没给 --ui-shots-file = 原样 submitLendWork；开关 off = 图不读、代码照交、带一句提示；否则读图自检 → 拷贝 → 记进 work.ui。
 * 截图不合格就拒交（journal 不动、不拷贝），原因说清；worker 改不好可以去掉参数只交代码。
 */
export async function submitWorkWithUi(db: Database, orderId: string, input: WorkInput, uiFile: string | undefined, d: SubmitterDeps,
  o: UiSubmitOpts = {}): Promise<SubmitOutcome & { note?: string }> {
  if (uiFile === undefined) return submitLendWork(db, orderId, input, d);
  if ((o.mode ?? lendUiUploadMode)() === "off") return { ...(await submitLendWork(db, orderId, input, d)), note: UI_OFF_NOTE };
  const row = getOrder(db, orderId);
  const ord = row ? orderOf(row) : null;
  if (!row?.dir || (row.state !== "started" && row.state !== "result_pending")) return submitLendWork(db, orderId, input, d); // 它给出拒绝理由
  const facts = { taskId: String(ord?.taskId ?? ""), head: String(ord?.head ?? ""), specRev: Number(ord?.specRev), round: Number(ord?.round) };
  const prep = prepareUiShots(row.dir, uiFile, facts, localFacts(row.dir, o.privacy));
  if (!prep.ok) return { ok: false, error: `${prep.error}；改好再交，或去掉 --ui-shots-file 只交代码` };
  const stored = storeUiCopies(row.dir, prep.copies);
  if (stored) return { ok: false, error: stored };
  return submitLendWork(db, orderId, { ...input, ui: prep.ui }, d);
}
