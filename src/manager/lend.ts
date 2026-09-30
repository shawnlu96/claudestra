/**
 * manager lend set|off|status 与 borrow set|off|status：写 / 看 lend.json（lib/lend-config.ts 读写，lib/lend-policy.ts 准入）。
 * 只做声明，领单循环不在这里（设计稿 docs/design/remote-capacity.md §2.3）。改动只许 owner / master（project-guard.ts）。
 */
import { LEND_PATH, readLend, updateLend, type LendFile } from "../lib/lend-config.js";
import { buildBorrowEntry, buildLendEntry, effectiveLend, readLendContext, type Built } from "../lib/lend-policy.js";
import { parseLedgerArgs } from "./ledger-identity.js";
import { output } from "./core.js";
import { requireOwnerOrMaster } from "./project-guard.js";

const LEND_USAGE =
  "usage: lend status | lend set <peer名|指纹> [--codex N] [--claude N] --repos owner/repo[,..] [--roles review] " +
  "[--orders-per-day N] [--confirm per-order|auto] [--until <ISO>] | lend off [--peer <名>]";
const BORROW_USAGE = "usage: borrow status | borrow set <peer名|指纹> --projects <id,..> [--roles review] [--max-open N] | borrow off [--peer <名>]";

const LEND_FLAGS = ["codex", "claude", "roles", "repos", "orders-per-day", "confirm", "until"];
const BORROW_FLAGS = ["projects", "roles", "max-open"];

async function status(kind: "lend" | "borrow"): Promise<void> {
  const read = await readLend();
  const ctx = await readLendContext();
  const eff = effectiveLend(read, ctx.contacts, ctx.projects);
  const base = { ok: true, path: LEND_PATH, file: read.status, ...(eff.invalid ? { invalid: eff.invalid } : {}), dropped: eff.dropped };
  if (kind === "lend") {
    const message = eff.invalid ? `lend.json 无效，按「关」处理：${eff.invalid}`
      : eff.lending ? `出借中：${eff.lend.map((e) => e.peer).join("、")}` : read.file.enabled ? "总开关开着，但没有仍有效的出借条目" : "不出借（总开关关）";
    return output({ ...base, enabled: read.file.enabled, lending: eff.lending, declared: read.file.lend, effective: eff.lend, message });
  }
  const message = eff.invalid ? `lend.json 无效，按「关」处理：${eff.invalid}`
    : eff.borrow.length ? `借入：${eff.borrow.map((e) => `${e.peer}（${e.projects.join(",")}）`).join("；")}` : "什么都不外借";
  output({ ...base, declared: read.file.borrow, effective: eff.borrow, message });
}

type AnyEntry = LendFile["lend"][number] | LendFile["borrow"][number];
type Ctx = Awaited<ReturnType<typeof readLendContext>>;

/**
 * 通过准入的条目按 peer 名 upsert；lend set 同时打开总开关（执行 set 本身就是 owner 的明确意思）。
 * 准入在拿到 lend 锁之后才读 peers / projects 再判：等锁期间联系人被删、项目被标成个人项目，都按新状态拒（tests/lend-cli.test.ts「P1-4」）。
 */
async function setEntry(kind: "lend" | "borrow", build: (ctx: Ctx) => Built<AnyEntry>): Promise<void> {
  const built = await updateLend(async (f) => {
    const b = build(await readLendContext());
    if (!b.ok) return b;
    const entry = b.entry;
    const list = (kind === "lend" ? f.lend : f.borrow) as (typeof entry)[];
    const i = list.findIndex((e) => e.peer === entry.peer);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    if (kind === "lend") f.enabled = true;
    return b;
  });
  if (!built.ok) return output({ ok: false, error: built.error });
  const entry = built.entry;
  output({ ok: true, [kind]: entry, message: "confirm" in entry
    ? `已开始向 ${entry.peer} 出借（${entry.confirm === "auto" ? `预先授权到 ${entry.until}：这段时间免逐单确认，每单仍通知你；到期后恢复逐单确认` : "每单等你确认"}）`
    : `已允许把 ${entry.projects.join("、")} 的单子给 ${entry.peer}：这些项目的 PR 会发给对方机器上的 agent 审（代码、规格与验收原文都会到对方那边）` });
}

async function off(kind: "lend" | "borrow", peer: string | undefined): Promise<void> {
  const res = await updateLend((f) => {
    const list: { peer: string }[] = kind === "lend" ? f.lend : f.borrow;
    if (peer !== undefined) {
      const i = list.findIndex((e) => e.peer === peer);
      if (i < 0) return `${kind} 里没有 peer ${peer}`;
      list.splice(i, 1);
      return null;
    }
    if (kind === "lend") f.enabled = false; // 只关总开关、保留条目：再 set 一条或手动改回 true 即恢复
    else f.borrow = [];
    return null;
  });
  if (res) return output({ ok: false, error: res });
  const message = kind === "lend"
    ? peer ? `已不再向 ${peer} 出借` : "出借已关闭（条目保留，lend set 会重新打开）"
    : peer ? `已不再把单子给 ${peer}` : "已清空借入列表：什么都不外借";
  output({ ok: true, message });
}

export async function cmdLend(kind: "lend" | "borrow", args: string[]): Promise<void> {
  const usage = kind === "lend" ? LEND_USAGE : BORROW_USAGE;
  const [sub = "status", ...rest] = args;
  if (sub === "status") return status(kind);
  if (sub === "submit" && kind === "lend") return (await import("./lend-submit.js")).cmdLendSubmit(rest); // 出借 worker 交结论（不过 owner 守卫）
  if (sub === "call" && kind === "lend") return (await import("./lend-call.js")).cmdLendCall(rest); // 调度服务调 A 的出借接口
  if (sub !== "set" && sub !== "off") return output({ ok: false, error: usage });
  const p = parseLedgerArgs(rest, sub === "off" ? ["peer"] : kind === "lend" ? LEND_FLAGS : BORROW_FLAGS);
  if ("error" in p) return output({ ok: false, error: `${p.error}；${usage}` });
  const denied = await requireOwnerOrMaster(kind === "lend" ? "改出借声明" : "改借入声明");
  if (denied) return output({ ok: false, code: "forbidden", ...denied });
  try {
    if (sub === "off") {
      if (p.pos.length) return output({ ok: false, error: usage });
      return await off(kind, p.flags.peer);
    }
    if (p.pos.length !== 1) return output({ ok: false, error: usage });
    const f = p.flags;
    await setEntry(kind, (ctx) => kind === "lend"
      ? buildLendEntry({ ref: p.pos[0], families: { codex: f.codex, claude: f.claude }, roles: f.roles, repos: f.repos,
        ordersPerDay: f["orders-per-day"], confirm: f.confirm, until: f.until }, ctx.contacts)
      : buildBorrowEntry({ ref: p.pos[0], projects: f.projects, roles: f.roles, maxOpen: f["max-open"] }, ctx.contacts, ctx.projects));
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
  }
}
