/**
 * manager lend grant|revoke|status 与 borrow set|off|status：写 / 看 lend.json（lib/lend-config.ts 读写，lib/lend-policy.ts 准入）。
 * 只做声明，领单循环不在这里（设计稿 docs/design/remote-capacity.md §2.3）。改动只许 owner / master（project-guard.ts）。
 * 出借是一次授权（lend grant，到期时间必填、最长 7 天）；收回（lend revoke）先删条目，调度服务下一轮停掉在跑的 worker。
 * lend set / off 是 grant / revoke 的旧名；逐单确认（--confirm）已退役。
 */
import { LEND_PATH, readLend, updateLend, type LendFile } from "../lib/lend-config.js";
import { SHELL_SENTENCE } from "../lib/lend-grant-rules.js";
import { buildBorrowEntry, buildGrant, effectiveLend, readLendContext, type Built } from "../lib/lend-policy.js";
import { parseLedgerArgs } from "./ledger-identity.js";
import { output } from "./core.js";
import { requireOwnerOrMaster } from "./project-guard.js";

const LEND_USAGE =
  "usage: lend status | lend grant <peer名|指纹> --repos owner/repo[,..] --until <ISO|3d|12h>（最长 7 天） [--codex N（缺省 5）] [--claude N] " +
  "[--roles review] [--orders-per-day N（缺省 200）] | lend revoke [--peer <名>]（不带 --peer = 全部收回）";
const BORROW_USAGE = "usage: borrow status | borrow set <peer名|指纹> --projects <id,..> [--roles review[,write]] [--max-open N] | borrow off [--peer <名>]";

/** confirm 留在表里只为认出旧写法、报「已退役」，不当未知参数 */
const LEND_FLAGS = ["codex", "claude", "roles", "repos", "orders-per-day", "confirm", "until"];
const CONFIRM_RETIRED = "逐单确认 / 限时预先授权（--confirm）已退役：改用一次授权 lend grant <peer> --repos … --until <到期时间>，到期前来单直接领，随时 lend revoke 收回";
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
 * 通过准入的条目按 peer 名 upsert（再授权一次 = 换掉旧条目，暂停的也就恢复了）；lend grant 同时打开总开关（执行它本身就是 owner 的明确意思）。
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
  if ("projects" in entry) {
    return output({ ok: true, [kind]: entry, message: `已允许把 ${entry.projects.join("、")} 的单子给 ${entry.peer}：这些项目的 PR 会发给对方机器上的 agent 审` +
      "（代码、规格与验收原文都会到对方那边）" + (entry.roles.includes("write") ? "；含写代码：开工 / 修复单由对方的 agent 写，推到本仓库的 lend/ 分支再走审查" : "") });
  }
  const slots = Object.entries(entry.families).map(([f, n]) => `${f} ${n} 个位`).join("、");
  output({ ok: true, [kind]: entry, warning: SHELL_SENTENCE, message: `${SHELL_SENTENCE}。已授权 ${entry.peer} 到 ${entry.until}：仓库 ${entry.repos.join("、")}，` +
    `角色 ${entry.roles.join("、")}，${slots}，每天最多 ${entry.ordersPerDay} 单；这段时间来单直接领，开跑和交付都会通知你。随时收回：manager lend revoke --peer ${entry.peer}` });
}

/** lend：删条目（不带 peer = 全删并关总开关），调度服务下一轮对还在跑的单按阶段退回或停掉；borrow：删条目 / 清空 */
async function off(kind: "lend" | "borrow", peer: string | undefined): Promise<void> {
  const res = await updateLend((f) => {
    const list: { peer: string }[] = kind === "lend" ? f.lend : f.borrow;
    if (peer !== undefined) {
      const i = list.findIndex((e) => e.peer === peer);
      if (i < 0) return `${kind} 里没有 peer ${peer}`;
      list.splice(i, 1);
      return null;
    }
    if (kind === "lend") Object.assign(f, { enabled: false, lend: [] });
    else f.borrow = [];
    return null;
  });
  if (res) return output({ ok: false, error: res });
  const message = kind === "lend"
    ? `已收回${peer ? `对 ${peer} 的` : "全部"}出借授权：还没领的单放弃，在跑的 worker 由调度服务下一轮（几秒内）停掉并确认退出；服务停着时 worker 宿主一分钟内自停`
    : peer ? `已不再把单子给 ${peer}` : "已清空借入列表：什么都不外借";
  output({ ok: true, message });
}

export async function cmdLend(kind: "lend" | "borrow", args: string[]): Promise<void> {
  const usage = kind === "lend" ? LEND_USAGE : BORROW_USAGE;
  const [sub = "status", ...rest] = args;
  if (sub === "status") return status(kind);
  if (sub === "submit" && kind === "lend") return (await import("./lend-submit.js")).cmdLendSubmit(rest); // 出借 worker 交结论（不过 owner 守卫）
  if (sub === "call" && kind === "lend") return (await import("./lend-call.js")).cmdLendCall(rest); // 调度服务调 A 的出借接口
  const op = kind === "lend" ? ({ grant: "set", set: "set", revoke: "off", off: "off" } as const)[sub] : sub === "set" || sub === "off" ? sub : undefined;
  if (!op) return output({ ok: false, error: usage });
  const p = parseLedgerArgs(rest, op === "off" ? ["peer"] : kind === "lend" ? LEND_FLAGS : BORROW_FLAGS);
  if ("error" in p) return output({ ok: false, error: `${p.error}；${usage}` });
  const denied = await requireOwnerOrMaster(kind === "lend" ? "改出借声明" : "改借入声明");
  if (denied) return output({ ok: false, code: "forbidden", ...denied });
  try {
    if (op === "off") {
      if (p.pos.length) return output({ ok: false, error: usage });
      return await off(kind, p.flags.peer);
    }
    if (p.pos.length !== 1) return output({ ok: false, error: usage });
    const f = p.flags;
    if (kind === "lend" && f.confirm !== undefined) return output({ ok: false, error: CONFIRM_RETIRED });
    await setEntry(kind, (ctx) => kind === "lend"
      ? buildGrant({ ref: p.pos[0], families: { codex: f.codex, claude: f.claude }, roles: f.roles, repos: f.repos,
        ordersPerDay: f["orders-per-day"], until: f.until }, ctx.contacts)
      : buildBorrowEntry({ ref: p.pos[0], projects: f.projects, roles: f.roles, maxOpen: f["max-open"] }, ctx.contacts, ctx.projects));
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
  }
}
