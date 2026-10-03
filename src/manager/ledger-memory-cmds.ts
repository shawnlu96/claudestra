/**
 * 项目记忆的 CLI（设计稿 docs/design/project-memory.md §2.2、§4.2）：record_memory / mark_memory 两个工具写台账的那一头，也给 owner / PM 在终端直接用。
 * 逻辑全在 lib/memory-tools.ts（角色、§4.2 权限、memoryLint）与 lib/memory-tools-refs.ts，这里只认身份：
 * - 带票据（bridge 过了身份门才签，lib/verdict-ticket.ts，绑定 actor + 参数 + 会话）→ verified，会话还要等于 registry 里这个 agent 的当前会话，
 *   执行者 / 审查员角色才从「当前的单」认出来；
 * - 不带票据 → 只认 owner / master / 项目 PM 名单（resolveActor 由频道推出 actor，执行者在 Bash 里跑认不成执行者）。
 * memory-show 只读；memory-refs 只跟在调用方自己记的那次交付后面（deliver 的 dedup 事件）。tests/memory-tools.test.ts。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { markAs, parseMarkArgs, parseRecordArgs, recordAs, showMemory, ticketBody, type MemoryCaller } from "../lib/memory-tools.js";
import { recordMemoryRefs } from "../lib/memory-tools-refs.js";
import { parseMemoryRefs } from "../lib/memory-tools-wire.js";
import { redeemVerdictTicket } from "../lib/verdict-ticket.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import { observeMemory } from "../lib/memory-auto.js";
import { configuredLesson } from "../lib/memory-auto-summary.js";
import { collectPrStage, realFactsDeps } from "../lib/ledger-verify-facts.js";
import { REPO_ROOT } from "../lib/repo-root.js";

const TICKET_FLAGS = ["wire", "session", "family", "ticket-file", "ticket", "dedup"];

/** 带票据：核票据与 registry 当前会话 → verified；不带：actor 本身（只够 owner / master / PM） */
async function callerOf(c: LedgerCli, wire: string): Promise<MemoryCaller> {
  const { session, family } = c.p.flags;
  if (c.p.flags["ticket-file"] === undefined && c.p.flags.ticket === undefined) {
    if (session !== undefined || family !== undefined) throw new LedgerError("forbidden", "--session / --family 只随 MCP 工具的票据给；终端直接跑不认会话");
    return { actor: c.deps.actor, sessionId: null, family: null, verified: false };
  }
  if (!session || !family || !redeemVerdictTicket(c.p.flags["ticket-file"], c.p.flags.ticket, c.deps.actor, ticketBody(wire, session, family))) {
    throw new LedgerError("forbidden", "票据对不上（只收 record_memory / mark_memory 工具经身份门签发的一次性票据）；这次没记");
  }
  const row = (await c.deps.loadRegistry()).agents[c.deps.actor] as { sessionId?: string } | undefined;
  if (!row?.sessionId || row.sessionId !== session) throw new LedgerError("forbidden", `--session 不是 ${c.deps.actor} 在 registry 里的当前会话：没记`);
  return { actor: c.deps.actor, sessionId: session, family, verified: true };
}

function wireOf(c: LedgerCli): { wire: string; raw: unknown } {
  const wire = c.need("wire");
  try {
    return { wire, raw: { v: 1, ...JSON.parse(wire) } };
  } catch (e) {
    throw new LedgerError("invalid", `--wire 不是合法 JSON：${(e as Error).message}`);
  }
}

async function recordCmd(c: LedgerCli) {
  const { wire, raw } = wireOf(c);
  const caller = await callerOf(c, wire);
  const p = parseRecordArgs(raw);
  if (!p.ok) throw new LedgerError("invalid", p.error);
  return recordAs(c.db, caller, p.value, c.deps.now());
}

/** 终端友好：不带 --wire 时用 <memoryId> --mark --reason --by --task --order 拼出同一份参数（不能带票据） */
async function markCmd(c: LedgerCli) {
  const f = c.p.flags;
  const fromFlags = f.wire === undefined;
  const { wire, raw } = fromFlags
    ? (() => {
      const a = { memoryId: c.p.pos[1], mark: f.mark, ...(f.reason ? { reason: f.reason } : {}), ...(f.by ? { by: f.by } : {}),
        ...(f.task ? { taskId: f.task } : {}), ...(f.order ? { orderId: f.order } : {}) };
      return { wire: JSON.stringify(a), raw: { v: 1, ...a } };
    })()
    : wireOf(c);
  if (fromFlags && (f["ticket-file"] !== undefined || f.ticket !== undefined)) throw new LedgerError("invalid", "带票据时要用 --wire");
  const caller = await callerOf(c, wire);
  const p = parseMarkArgs(raw);
  if (!p.ok) throw new LedgerError("invalid", p.error);
  return markAs(c.db, caller, p.value, c.deps.now());
}

function showCmd(c: LedgerCli) {
  const id = c.p.pos[1];
  if (!id) throw new LedgerError("invalid", "缺记忆 id");
  const v = showMemory(c.db, id);
  if (!v) throw new LedgerError("not_found", `没有记忆 ${id}`);
  return { ok: true, ...v };
}

function refsCmd(c: LedgerCli) {
  const orderId = c.p.pos[1];
  if (!orderId) throw new LedgerError("invalid", "缺 <orderId>");
  let raw: unknown;
  try { raw = JSON.parse(c.need("refs")); } catch (e) { throw new LedgerError("invalid", `--refs 不是合法 JSON：${(e as Error).message}`); }
  const refs = parseMemoryRefs(raw, (path, why) => { throw new LedgerError("invalid", `${path}: ${why}`); });
  return { ok: true, ...recordMemoryRefs(c.db, c.deps.actor, { orderId, head: c.need("head"), refs }, c.deps.now()) };
}

export const MEMORY_CMDS: Record<string, CommandSpec> = {
  "memory-auto": {
    valued: ["project"], usage: "memory-auto --project <id>（调度器的本机记忆观察器）",
    run: async (c) => ({ ok: true, ...await observeMemory(c.db, c.deps.actor, c.project(), {
      assertLease: c.deps.assertLease, lesson: configuredLesson,
      files: async (t) => t.pr ? (await collectPrStage(c.deps.factsDeps?.() ?? realFactsDeps(REPO_ROOT), t.pr)).pr?.files ?? null : null,
    }) }),
  },
  "memory-record": {
    valued: TICKET_FLAGS,
    usage: "memory-record --wire <JSON {kind,title,symptom,rule,files,family?,fixable,orderId?|project}>（记坑 / 总结补充；PM / owner 直接跑，执行者 / 审查员用 MCP record_memory）",
    run: recordCmd,
  },
  "memory-mark": {
    valued: [...TICKET_FLAGS, "mark", "reason", "by", "task", "order"],
    usage: "memory-mark <memoryId> --mark confirm|dispute|retract|supersede|link_fix|unlink_fix [--reason --by <新 id> --task <修复卡> --order <当前单>]（或 --wire）",
    run: markCmd,
  },
  "memory-show": { valued: [], usage: "memory-show <memoryId>（全文 + 状态 + marks 历史）", run: showCmd },
  "memory-refs": {
    valued: ["head", "refs", "dedup"],
    usage: "memory-refs <orderId> --head <sha> --refs <JSON [{id,use,note?}]>（deliver 工具交付后补记；wrong 自动转为 dispute）",
    run: refsCmd,
  },
};
