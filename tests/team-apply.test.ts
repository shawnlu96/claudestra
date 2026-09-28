/**
 * PM 名单 / 班子配置只能经 owner 确认的提案写进台账：`ledger meta --pms` 只生成提案，`ledger team-apply` 核对三件事
 * （bridge 标过 confirmed、参数哈希一致、确认时未过期）才写（src/manager/ledger-team-cmds.ts）；
 * 硬规则的 `ledger escalate --auto` 只给 bridge 用，记在 bridge-rule 名下。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { newProposal, readProposals, updateProposals, type TeamProposal } from "../src/lib/team-proposal.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "p";
const NOW = 5_000_000;
let db: Database;
let path: string;
let posted: TeamProposal[];
let postError: string | null;
const reg: Registry = {
  socket: "s",
  agents: {
    "agent-pm": { status: "active", projectId: P, channelId: "c-pm" } as unknown as Registry["agents"][string],
    "agent-exec": { status: "active", projectId: P } as Registry["agents"][string],
  },
};

function run(actor: string, now: number, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P], now: () => now,
    loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {},
    proposals: { path, post: async (p) => (posted.push(p), postError) },
  }) as Promise<Record<string, any>>;
}

async function put(p: TeamProposal): Promise<void> {
  await updateProposals((all) => void (all[p.id] = p), NOW, path);
}

const draft = (pms: string[]) => ({ kind: "pms" as const, project: P, proposer: "agent-pm", pm: null, pms, dispatcher: null, audit: true });
const confirmed = (p: TeamProposal, at = NOW + 1): TeamProposal => ({ ...p, status: "confirmed", confirmedAt: at });

beforeEach(() => {
  db = openLedger(tempLedgerPath("team-apply-"));
  path = join(mkdtempSync(join(tmpdir(), "team-apply-")), "proposals.json");
  posted = [];
  postError = null;
  setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now: 2 }, { project: P, id: "T1", title: "x", kind: "code", agent: "agent-exec" });
});

describe("ledger meta --pms：只生成提案", () => {
  test("PM 提议：写提案、贴按钮，台账不变；执行者不能提议；owner 在终端里也一样要点按钮", async () => {
    const r = await run("agent-pm", NOW, "meta", "--pms", "pm, Exec");
    expect(r).toMatchObject({ ok: true, status: "pending", meta: { pms: ["agent-pm"] } });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "pms", pms: ["agent-pm", "agent-exec"], proposer: "agent-pm" });
    expect((await readProposals(path))[r.proposal]).toMatchObject({ status: "pending" });
    expect(getMeta(db, P).pms).toEqual(["agent-pm"]);
    expect((await run("agent-exec", NOW, "meta", "--pms", "exec")).code).toBe("forbidden");
    expect(await run("owner", NOW, "meta", "--pms", "pm")).toMatchObject({ ok: true, status: "pending" });
    expect(getMeta(db, P).pms).toEqual(["agent-pm"]);
    expect(isWriteInvocation("ledger", ["meta", "--pms", "a"])).toBe(true);
  });

  test("按钮贴不出去：提案留着、报错说明；--team / --dispatcher 不能直接设，指向 team up / down", async () => {
    postError = "找不到能贴按钮的频道";
    expect(await run("agent-pm", NOW, "meta", "--pms", "pm")).toMatchObject({ ok: false, error: expect.stringContaining("提案已记下") });
    expect(Object.values(await readProposals(path))).toHaveLength(1);
    for (const flags of [["--team", "on"], ["--dispatcher", "d"]]) {
      expect(await run("owner", NOW, "meta", ...flags)).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("team up") });
    }
    expect(getMeta(db, P).team).toBeNull();
  });
});

describe("ledger team-apply", () => {
  test("核对通过才写：PM 名单 + owner 决定（标转录），结案 applied；再跑一次被拒、不重复写", async () => {
    const p = newProposal(draft(["agent-pm", "agent-exec"]), NOW, "0a1b2c3d");
    await put(confirmed(p));
    expect(await run("owner", NOW + 2, "team-apply", p.id)).toMatchObject({ ok: true, kind: "pms", pms: ["agent-pm", "agent-exec"] });
    expect(getMeta(db, P).pms).toEqual(["agent-pm", "agent-exec"]);
    expect((await readProposals(path))[p.id]?.status).toBe("applied");
    const count = listEvents(db).length;
    expect(await run("owner", NOW + 3, "team-apply", p.id)).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("已经写进台账了") });
    expect(listEvents(db)).toHaveLength(count);
    expect(listEvents(db).filter((e) => e.kind === "decision")).toEqual([expect.objectContaining({ actor: "owner", data: { transcribed: true, proposal: p.id } })]);
  });

  test("up 写班子配置、down 关掉；三处写入都在 owner 名下", async () => {
    const up = newProposal({ ...draft(["agent-pm", "agent-d"]), kind: "up", pm: "agent-pm", dispatcher: { agent: "agent-d", create: false } }, NOW, "11111111");
    await put(confirmed(up));
    await run("owner", NOW + 2, "team-apply", up.id);
    expect(getMeta(db, P).team).toMatchObject({ dispatcher: "agent-d", audit: true });
    const down = newProposal({ ...draft(["agent-pm"]), kind: "down", dispatcher: { agent: "agent-d", create: false }, audit: false }, NOW, "22222222");
    await put(confirmed(down));
    await run("owner", NOW + 2, "team-apply", down.id);
    expect(getMeta(db, P)).toMatchObject({ pms: ["agent-pm"], team: null });
  });

  test("拒绝：agent 身份、没经确认（pending）、已经写过（applied）、确认后被改、过期后才确认、确认超过 10 分钟", async () => {
    const p = newProposal(draft(["agent-evil"]), NOW, "33333333");
    const cases: [TeamProposal, string, string][] = [
      [confirmed(p), "agent-pm", "只在 owner 点确认后"],
      [p, "owner", "没有经 owner 确认"],
      [{ ...confirmed(p), status: "applied" }, "owner", "已经写进台账了"],
      [{ ...confirmed(p), pms: ["agent-pm", "agent-evil"] }, "owner", "被改过"],
      [confirmed(p, p.expiresAt + 1), "owner", "过期后才确认"],
    ];
    for (const [q, actor, why] of cases) {
      await put(q);
      expect(await run(actor, NOW + 2, "team-apply", q.id)).toMatchObject({ ok: false, error: expect.stringContaining(why) });
    }
    await put(confirmed(p));
    expect((await run("owner", NOW + 11 * 60_000, "team-apply", p.id)).error).toContain("超过 10 分钟");
    expect(await run("owner", NOW, "team-apply", "ffffffff")).toMatchObject({ ok: false, error: "提案不存在" });
    expect(getMeta(db, P).pms).toEqual(["agent-pm"]);
  });
});

describe("ledger escalate --auto（硬规则）", () => {
  test("bridge（owner 身份）调用：记在 bridge-rule 名下、带 auto；dedup 按 review seq 幂等；agent 与 --to owner 都不行", async () => {
    const r = await run("owner", NOW, "escalate", "T1", "--reason", "第 1 轮审出 P0", "--auto", "--dedup", "auto-escalate:9");
    expect(r.event).toMatchObject({ actor: "bridge-rule", kind: "escalate", data: { to: "pm", reason: "第 1 轮审出 P0", auto: true } });
    expect((await run("owner", NOW, "escalate", "T1", "--reason", "第 1 轮审出 P0", "--auto", "--dedup", "auto-escalate:9")).duplicate).toBe(true);
    expect((await run("agent-pm", NOW, "escalate", "T1", "--reason", "x", "--auto")).code).toBe("forbidden");
    expect((await run("owner", NOW, "escalate", "T1", "--reason", "x", "--auto", "--to", "owner")).code).toBe("forbidden");
  });
});
