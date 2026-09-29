/**
 * 本机接受过的跨实例委托（T47）：接方 owner 同意、用 `peer-ledger <peer> accept <任务>` 在对方卡上记了接受之后，在这里记一笔。
 * peer 消息的注入头（bridge/router.ts renderApiInbound）按它判：首行 `[协作 Txx/步骤]` 且这里有「这个 peer 的 Txx」才算已接受卡上的
 * 步骤单、不再先问 owner；没有就一律按新委托处理——对方把新任务写成 /步骤 也绕不过接方 owner。tests/ledger-steps.test.ts。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

const FILE = statePath("peer-accepted.json");
type Store = Record<string, Record<string, { at: number }>>;
/** peer 名 / 任务号都要是普通标识符（__proto__ 这类原型键进不了对象） */
const KEY_RE = /^(?!__proto__$|constructor$|prototype$)[\p{L}\p{N}_.:-]{1,64}$/u;

function load(file: string): Store {
  const r = readJsonStateSync(file);
  return r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as Store) : {};
}

export function isPeerTaskAccepted(peer: string, task: string, file = FILE): boolean {
  return KEY_RE.test(peer) && KEY_RE.test(task) && Object.hasOwn(load(file)[peer] ?? {}, task);
}

export function markPeerTaskAccepted(peer: string, task: string, at = Date.now(), file = FILE): void {
  if (!KEY_RE.test(peer) || !KEY_RE.test(task)) throw new Error("peer 名或任务号不合法");
  const s = load(file);
  writeJsonAtomicSync(file, { ...s, [peer]: { ...(s[peer] ?? {}), [task]: { at } } });
}
