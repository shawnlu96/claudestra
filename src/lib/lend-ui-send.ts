/**
 * LENDUI2：出借方 B 交付写单时把 worker 交的截图逐张传给 A（POST /api/v1/lend/shot，经 LendDeps.shot = `manager lend call <peer> shot`），
 * 全部传成再拼一份 uiEvidence 清单交给 lend-drive.ts publishWork 放进交付正文。publishWork 只在拿到 PR 之后、落正文之前调一次 sendUiShots。
 * 开关是恢复键 lendUiUpload（lend-key-mode.ts，缺省 off、只认显式值）：off / 端口不在 / work 里没有 ui = 什么都不做，交付和改动前逐字相同；
 * observe = 不上传，lend_meta 记一条 uiShotsObserved:<单号>（同一个 head 只记一次），交付不带清单；on = 上传、带清单。
 * 进度记在 lend_meta lend-ui-up:<单号>（head 变了重来，已成的槽位不重传）。全有或全无：一张永久失败就不带清单交付（A 已收下的留着、不登记）；
 * 暂时失败本轮不落正文、下一轮接着传，从第一次上传起满 PUBLISH_GIVE_UP_MS 还不成就不带清单交付。每轮每单开始上传 20 秒后不再起新的上传（至少一张）。
 * 每张之前先过守卫（只核不记）、再重读拷贝核 sha256；A 回的 sha256 / bytes / 宽高要和本地拷贝逐项相等（端到端摘要核对）。
 * 日志只写 code，不写本机路径（心跳摘要会发给 A）。tests/lend-ui-send.test.ts。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LendDeps } from "./lend-drive.js";
import { getMeta, orderOf, setMeta, type LendRow, type WorkUi, type WorkUiShot } from "./lend-journal.js";
import { lendUiUploadMode } from "./lend-key-mode.js";
import type { PublishDenial } from "./lend-push.js";
import { PUBLISH_GIVE_UP_MS } from "./lend-pr-takeover-retry.js";
import { readBytesIn } from "./lend-submit.js";
import { LEND_SHOT_LIMITS } from "./lend-ui-wire.js";
import { parseUiEvidence, uiEvidenceDigest, type UiEvidence, type UiShot } from "./order-deliver-ui.js";
import type { RecoveryMode } from "./recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

/** 拷贝放在工作副本的 .git 下：git 不跟踪，副本删掉时跟着删（lend-ui-submit.ts 写、这里读） */
export const UI_COPY_DIR = "lend-ui-shots";
export const uiCopyPath = (dir: string, sha256: string): string => join(dir, ".git", UI_COPY_DIR, `${sha256}.png`);
/** 清单的规范顺序（同 order-deliver-ui.ts shotOrder）：view、size 按码元比，before 在 after 前 */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const uiShotOrder = (a: Pick<UiShot, "view" | "size" | "phase">, b: Pick<UiShot, "view" | "size" | "phase">): number =>
  cmp(a.view, b.view) || cmp(a.size, b.size) || cmp(a.phase === "before" ? "0" : "1", b.phase === "before" ? "0" : "1");
export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** 每轮每单的上传预算：开始上传超过这么久不再起新的一张 */
const UI_ROUND_BUDGET_MS = 20_000;
const REF = /^s\d{2}\.png$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PERMANENT = new Set([400, 401, 403, 404, 409, 413]);
const CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** 单测换开关（生产不调，读本机恢复策略） */
let modeOf: () => RecoveryMode = () => lendUiUploadMode();
export function useUiUploadMode(m: (() => RecoveryMode) | null): void { modeOf = m ?? (() => lendUiUploadMode()); }

interface Done { ref: string; sha256: string; bytes: number; width: number; height: number }
interface Progress { head: string; since: number | null; done: Record<string, Done>; failed?: string }

export type UiSend = { kind: "none" } | { kind: "ok"; evidence: UiEvidence } | { kind: "wait" } | { kind: "halt"; denied: PublishDenial };
type Guard = { check(effect: "payload"): Promise<PublishDenial | null> };
type SendDeps = Pick<LendDeps, "db" | "now" | "log" | "shot">;

const upKey = (orderId: string): string => `lend-ui-up:${orderId}`;
export const uiObservedKey = (orderId: string): string => `uiShotsObserved:${orderId}`;
const slotKey = (s: Pick<UiShot, "view" | "size" | "phase">): string => `${s.view} ${s.size} ${s.phase}`;

function readProgress(d: SendDeps, row: LendRow, head: string): Progress {
  try {
    const p = JSON.parse(getMeta(d.db, upKey(row.orderId)) ?? "null") as Progress | null;
    if (p && p.head === head && p.done && typeof p.done === "object") return p;
  } catch { /* 坏值当没传过：从头传，A 对同槽位同字节回原来的 ref */ }
  return { head, since: null, done: {} };
}
const saveProgress = (d: SendDeps, orderId: string, p: Progress): void => setMeta(d.db, upKey(orderId), JSON.stringify(p));

/** observe：本会传几张、多少字节，同一个 head 只记一次 */
function observe(d: SendDeps, row: LendRow, head: string, ui: WorkUi): void {
  try { if ((JSON.parse(getMeta(d.db, uiObservedKey(row.orderId)) ?? "null") as { head?: unknown } | null)?.head === head) return; } catch { /* 坏值重记 */ }
  setMeta(d.db, uiObservedKey(row.orderId), JSON.stringify({ head, shots: ui.shots.length, bytes: ui.shots.reduce((n, s) => n + s.bytes, 0), at: d.now() }));
}

type Answer = { ok: true; done: Done } | { ok: false; permanent: boolean; code: string };

/** A 对一张图的回答：200 严格解析并逐项对本地拷贝；404 / 403 / 400 / 401 / 409 / 413 永久；其余（503、正文坏了）暂时 */
function classifyShotAnswer(res: { status: number; body: unknown }, local: WorkUiShot): Answer {
  const b = res.body as Record<string, unknown> | null;
  if (res.status === 200) {
    const keys = ["ok", "v", "ref", "sha256", "bytes", "width", "height"];
    const shaped = !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === keys.length && keys.every((k) => k in b)
      && b.ok === true && b.v === 1 && typeof b.ref === "string" && REF.test(b.ref) && typeof b.sha256 === "string" && HEX64.test(b.sha256)
      && [b.bytes, b.width, b.height].every((n) => Number.isSafeInteger(n));
    if (!shaped) return { ok: false, permanent: false, code: "bad_response" };
    const same = b.sha256 === local.sha256 && b.bytes === local.bytes && b.width === local.width && b.height === local.height;
    return same ? { ok: true, done: { ref: b.ref as string, sha256: local.sha256, bytes: local.bytes, width: local.width, height: local.height } }
      : { ok: false, permanent: true, code: "answer_mismatch" };
  }
  const code = b && typeof b === "object" && typeof b.code === "string" && CODE.test(b.code) ? b.code : `status_${res.status}`;
  return { ok: false, permanent: PERMANENT.has(res.status), code };
}

/** 全部槽位都成了：拼清单并过 parseUiEvidence；不合法 = null（记 manifest_invalid） */
function manifestOf(row: LendRow, head: string, ui: WorkUi, p: Progress): UiEvidence | null {
  const o = orderOf(row);
  const shots = ui.shots.map((s) => ({ view: s.view, size: s.size, phase: s.phase, ref: p.done[slotKey(s)]!.ref, sha256: s.sha256 })).sort(uiShotOrder);
  const e = { v: 1 as const, taskId: String(o?.taskId ?? ""), head, specRev: Number(o?.specRev), round: Number(o?.round) + 1, source: "imported" as const,
    summary: ui.summary, shots };
  try { return parseUiEvidence({ ...e, digest: uiEvidenceDigest(e) }); } catch { return null; }
}

/**
 * publishWork 的一次调用：none = 不带清单照常交付；ok = 带这份清单；wait = 本轮不落正文（下一轮再走 publishWork）；halt = 守卫拦下，按 haltPublish 收尾。
 * 服务停止 / 失租（SchedulerStopped）原样往外抛。
 */
export async function sendUiShots(row: LendRow, d: SendDeps, g: Guard): Promise<UiSend> {
  const work = row.work, ui = work?.ui;
  if (!work || !ui || !d.shot) return { kind: "none" };
  const mode = modeOf();
  if (mode === "off") return { kind: "none" };
  if (mode === "observe") return (observe(d, row, work.head, ui), { kind: "none" });
  const p = readProgress(d, row, work.head);
  const give = (code: string): UiSend => {
    if (!p.failed) saveProgress(d, row.orderId, { ...p, failed: code });
    d.log(`${row.orderId} 截图不随交付：${code}`);
    return { kind: "none" };
  };
  if (p.failed) return { kind: "none" };
  const shots = [...ui.shots].sort(uiShotOrder);
  const start = d.now();
  let sent = 0;
  for (const s of shots) {
    if (p.done[slotKey(s)]) continue;
    if (p.since !== null && d.now() - p.since >= PUBLISH_GIVE_UP_MS) return give("give_up");
    if (sent > 0 && d.now() - start >= UI_ROUND_BUDGET_MS) return { kind: "wait" };
    const denied = await g.check("payload");
    if (denied) return { kind: "halt", denied };
    const path = uiCopyPath(row.dir ?? "", s.sha256);
    const copy = row.dir ? readBytesIn(row.dir, path, { max: LEND_SHOT_LIMITS.png, what: "截图拷贝", field: "path" }) : null;
    if (!copy?.ok || sha256Hex(copy.bytes) !== s.sha256 || copy.bytes.length !== s.bytes) return give("local_changed");
    if (p.since === null) p.since = d.now();
    saveProgress(d, row.orderId, p);
    sent++;
    let a: Answer;
    try {
      const meta = { orderId: row.orderId, gen: row.leaseGen, head: work.head, view: s.view, size: s.size, phase: s.phase };
      a = classifyShotAnswer(await d.shot(row.peer, "shot", { meta, file: path }), s);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      a = { ok: false, permanent: false, code: "transport" };
    }
    if (a.ok) { p.done[slotKey(s)] = a.done; saveProgress(d, row.orderId, p); continue; }
    if (a.permanent) return give(a.code);
    if (d.now() - p.since >= PUBLISH_GIVE_UP_MS) return give(`give_up_${a.code}`);
    d.log(`${row.orderId} 截图上传暂未成功（${a.code}），下轮接着传`);
    return { kind: "wait" };
  }
  const evidence = manifestOf(row, work.head, ui, p);
  return evidence ? { kind: "ok", evidence } : give("manifest_invalid");
}
