/**
 * i28-W1c：出借授权里写 Codex 模型 / 推理档，出借 worker 按授权起（src/lib/lend-config.ts 校验、src/manager/lend.ts grant / status、
 * src/lib/lend-grant-spawn.ts lendModelArgs 起之前现读）。模型只由出借方在 lend.json 里定，借入方的订单内容影响不到。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendFileProblem, type LendEntry } from "../src/lib/lend-config.js";
import { CHOICE_CHANGED, LEND_ORDER_ENV, lendCreateDenied, lendModelArgs } from "../src/lib/lend-grant-spawn.js";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { harness } from "./lend-harness.js";

const FP = "abcd-ef01-2345-6789";
const GRANT: LendEntry = { peer: "a", fp: FP, families: { codex: 1 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 5,
  grantedAt: new Date(0).toISOString(), until: new Date(6 * 86_400_000).toISOString() };
const fileWith = (e: Record<string, unknown>) => ({ version: 2, enabled: true, lend: [e], borrow: [] });

describe("lend.json 校验：codexModel / codexEffort", () => {
  test("合法值、旧条目（没这两个字段）都过", () => {
    expect(lendFileProblem(fileWith({ ...GRANT }))).toBeNull();
    expect(lendFileProblem(fileWith({ ...GRANT, codexModel: "gpt-6-astra", codexEffort: "xhigh" }))).toBeNull();
    expect(lendFileProblem(fileWith({ ...GRANT, codexModel: "gpt-5.1-codex" }))).toBeNull();
    for (const eff of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) expect(lendFileProblem(fileWith({ ...GRANT, codexEffort: eff }))).toBeNull();
    expect(lendFileProblem(fileWith({ ...GRANT, codexModel: "a".repeat(64) }))).toBeNull();
  });

  test("能带进 create 参数的模型名一律拒：空格、换行、- 开头、大写、引号、超长、空串、非字符串", () => {
    const bad: unknown[] = ["x --dangerously-bypass-approvals-and-sandbox", "gpt 6", "gpt-6\n--model", "gpt-6\r", "-gpt", "--model", "GPT-6", "gpt\"6",
      "gpt;rm", "gpt/6", "a".repeat(65), "", 6, null, ["gpt-6"], "gpt-6\u0000"];
    for (const m of bad) expect(lendFileProblem(fileWith({ ...GRANT, codexModel: m }))).toContain("codexModel");
  });

  test("未知档位拒（含 ultracode 这类折算别名、大小写、带空格）；未知键仍拒", () => {
    for (const eff of ["ultracode", "extreme", "XHIGH", " xhigh", "xhigh ", "", "auto", "default", 3]) {
      expect(lendFileProblem(fileWith({ ...GRANT, codexEffort: eff }))).toContain("codexEffort");
    }
    expect(lendFileProblem(fileWith({ ...GRANT, model: "gpt-6-astra" }))).toContain("不认识的字段 model");
    expect(lendFileProblem(fileWith({ ...GRANT, codexArgs: ["--x"] }))).toContain("不认识的字段 codexArgs");
  });

  test("暂停条目带非法值也整份无效（不挑着用）", () => {
    expect(lendFileProblem(fileWith({ ...GRANT, paused: { reason: "r" }, codexModel: "-x" }))).toContain("codexModel");
  });
});

/** 一张已领、已 clone、已记 worker 名的单（出借服务调 manager create 时 journal 就是这样）；预览 / wire 里塞对方想要的模型 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lend-model-"));
  const f = { journal: join(dir, "journal.sqlite"), lendPath: join(dir, "lend.json"), now: 1 };
  const grant = (lend: object[], enabled = true) => writeFileSync(f.lendPath, JSON.stringify({ version: 2, enabled, lend, borrow: [] }));
  grant([GRANT]);
  const db = openLendJournal(f.journal);
  const evil = { model: "evil-model", codexModel: "evil-model", effort: "minimal", codexEffort: "minimal" };
  recordAsked(db, { orderId: "o1", peer: "a", fp: FP, family: "codex", preview: { repo: "o/r", step: "review", ...evil } }, 0);
  advance(db, "o1", "asked", "claimed", { leaseUntil: 9e15, leaseGen: 1, wire: { text: "--model evil", order: { ...evil, repo: "o/r" } } as never });
  advance(db, "o1", "claimed", "cloned", { dir: "/w" });
  patchOrder(db, "o1", ["cloned"], { agent: "agent-lend-x" });
  const args = (order = "o1") => lendModelArgs(db, order, f.lendPath);
  /** manager create 子进程的最终闸口；argv = 父进程组好的 --model / --effort（manager.ts 解析成 model / effort 传进来） */
  const gate = (argv: string[] = []) => {
    const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
    return lendCreateDenied("agent-lend-x", { ...f, env: { [LEND_ORDER_ENV]: "o1" }, choice: { model: at("--model"), effort: at("--effort") } });
  };
  return { db, grant, args, gate };
}

describe("起出借 worker 时的 create 参数（lendModelArgs）", () => {
  test("授权有字段：按数组带 --model / --effort；只写一个就只带一个；没写 = 不加参数（和以前一样）", () => {
    const { grant, args } = fixture();
    expect(args()).toEqual([]);
    grant([{ ...GRANT, codexModel: "gpt-6-astra", codexEffort: "xhigh" }]);
    expect(args()).toEqual(["--model", "gpt-6-astra", "--effort", "xhigh"]);
    grant([{ ...GRANT, codexEffort: "high" }]);
    expect(args()).toEqual(["--effort", "high"]);
    grant([{ ...GRANT, codexModel: "gpt-6-astra" }]);
    expect(args()).toEqual(["--model", "gpt-6-astra"]);
  });

  test("每次现读：两步之间改了就用新的；收回 / 关掉 / 指纹变了 / 文件坏了 = 不带参数，且 manager create 的核对照样拒起", () => {
    const { grant, args, gate } = fixture();
    grant([{ ...GRANT, codexModel: "gpt-6-astra", codexEffort: "xhigh" }]);
    expect(gate(args())).toBeNull();
    grant([{ ...GRANT, codexModel: "gpt-6", codexEffort: "medium" }]); // gate 之后、create 之前出借方改了授权
    expect(args()).toEqual(["--model", "gpt-6", "--effort", "medium"]);
    grant([]); // 两步之间收回
    expect(args()).toEqual([]);
    expect(gate()).toMatch(/已收回/);
    grant([{ ...GRANT, codexModel: "gpt-6-astra" }], false);
    expect(args()).toEqual([]);
    expect(gate()).toMatch(/已收回/);
    grant([{ ...GRANT, fp: "1111-2222-3333-4444", codexModel: "gpt-6-astra" }]);
    expect(args()).toEqual([]);
    grant([{ ...GRANT, codexModel: "-x" }]); // 手改出非法值：整份无效，不带
    expect(args()).toEqual([]);
    expect(gate()).toMatch(/无效/);
  });

  test("借入方给的订单内容（预览、wire 里的 model / effort）影响不到；别的 peer 的授权也不串", () => {
    const { grant, args } = fixture();
    expect(args()).toEqual([]);
    grant([{ ...GRANT, peer: "b", codexModel: "gpt-6-astra", codexEffort: "xhigh" }, { ...GRANT, codexEffort: "low" }]);
    expect(args()).toEqual(["--effort", "low"]);
    expect(args("no-such-order")).toEqual([]);
  });

  test("出借服务起 worker 那一行把现读的参数接在 create 后面（lend-deps.ts）", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/lend-deps.ts"), "utf8");
    expect(src).toContain(`...lendRuntimeArgs(journal, order), ...lendModelArgs(journal, order));`);
  });
});

describe("manager create 最终闸口：父进程组好参数之后授权里的模型 / 推理档变了就不起（r1 P1）", () => {
  const cases: [string, object, object][] = [
    ["只改模型", { codexModel: "gpt-6-astra", codexEffort: "xhigh" }, { codexModel: "gpt-6-sol", codexEffort: "xhigh" }],
    ["只改推理档", { codexModel: "gpt-6-astra", codexEffort: "xhigh" }, { codexModel: "gpt-6-astra", codexEffort: "high" }],
    ["无字段改有字段", {}, { codexModel: "gpt-6-astra", codexEffort: "xhigh" }],
    ["无字段改只有档位", {}, { codexEffort: "low" }],
    ["有字段改无字段", { codexModel: "gpt-6-astra", codexEffort: "xhigh" }, {}],
  ];
  for (const [label, before, after] of cases) {
    test(`${label}：拒起；重派后按新授权组参数就放行`, () => {
      const { grant, args, gate } = fixture();
      grant([{ ...GRANT, ...before }]);
      const argv = args(); // 出借服务（父进程）组参数
      grant([{ ...GRANT, ...after }]); // 子进程走到闸口之前出借方改了授权
      expect(gate(argv)).toBe(CHOICE_CHANGED);
      expect(gate(args())).toBeNull();
    });
  }

  test("授权没变照常放行（有字段、无字段）；先查收回再比模型；参数和授权对不上（手传别的模型）也拒", () => {
    const { grant, args, gate } = fixture();
    expect(gate(args())).toBeNull();
    grant([{ ...GRANT, codexModel: "gpt-6-astra", codexEffort: "xhigh" }]);
    expect(gate(args())).toBeNull();
    expect(gate(["--model", "gpt-6-astra"])).toBe(CHOICE_CHANGED);
    expect(gate(["--model", "other", "--effort", "xhigh"])).toBe(CHOICE_CHANGED);
    const argv = args();
    grant([]);
    expect(gate(argv)).toMatch(/已收回/);
  });
});

describe("CHOICE_CHANGED 拒起后的实际去向（真实 lendTick）：退回发起方，不原地重试", () => {
  test("授权仍有效、create 被最终闸口按 CHOICE_CHANGED 拒：单子 released，向 A 报 release / not_started，原因是这句文案", async () => {
    const h = harness();
    let gateOk: string | null = "没调";
    h.d.worker.create = async (_n, _dir, _purpose, gate) => ((gateOk = await gate()), { ok: false, error: CHOICE_CHANGED });
    for (let i = 0; i < 5; i++) await h.tick();
    expect(gateOk).toBeNull(); // 授权仍然有效：不是按收回收尾
    const row = getOrder(h.db, "o1")!;
    expect(row.state).toBe("released");
    expect(row.reason).toBe(`起 worker 失败：${CHOICE_CHANGED}`);
    expect(h.calls.filter((c) => c.op === "lease").map((c) => c.body)).toEqual([expect.objectContaining({ action: "release", reason: "not_started" })]);
    expect(h.log.created).toEqual([]);
    expect(CHOICE_CHANGED).toContain("单子退回发起方重派，下次领单按新授权起");
    expect(CHOICE_CHANGED).not.toMatch(/下一轮|重建|重试/);
  });
});

describe("manager lend grant / status 接线", () => {
  const state = mkdtempSync(join(tmpdir(), "lend-model-cli-"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-exec": { channelId: "222", status: "active" } } }));
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "team-a", fp: "aaaa-bbbb-cccc-dddd", addedAt: "" }], pendingInvites: [] }));
  mkdirSync(join(state, "orch"));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "orch", name: "orch", dirs: [join(state, "orch")], createdAt: "" }] }));
  const manager = join(import.meta.dir, "../src/manager.ts");
  const run = (args: string[], channel?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, DISCORD_CHANNEL_ID: channel };
    if (!channel) delete env.DISCORD_CHANNEL_ID;
    const r = Bun.spawnSync([process.execPath, manager, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!) as Record<string, any>;
  };
  const lend = () => JSON.parse(readFileSync(join(state, "lend.json"), "utf8")).lend as Record<string, unknown>[];
  const g = (...extra: string[]) => ["lend", "grant", "team-a", "--repos", "shawnlu96/claudestra", "--until", "3d", ...extra];

  test("写入与 status 显示；非法值拒且不写；执行者被拒；重授不带就清掉", () => {
    expect(run(g("--codex-model", "x --dangerously-bypass-approvals-and-sandbox"))).toMatchObject({ ok: false, error: expect.stringContaining("--codex-model") });
    expect(run(g("--codex-model", "-x"))).toMatchObject({ ok: false, error: expect.stringContaining("--codex-model") });
    expect(run(g("--codex-effort", "ultracode"))).toMatchObject({ ok: false, error: expect.stringContaining("--codex-effort") });
    expect(run(g("--codex-model", "gpt-6-astra"), "222")).toMatchObject({ ok: false, code: "forbidden" });
    const ok = run(g("--codex-model", "gpt-6-astra", "--codex-effort", "xhigh"));
    expect(ok).toMatchObject({ ok: true, lend: { peer: "team-a", codexModel: "gpt-6-astra", codexEffort: "xhigh" } });
    expect(ok.message).toContain("codex 模型 gpt-6-astra · 推理档 xhigh");
    expect(lend()).toEqual([expect.objectContaining({ codexModel: "gpt-6-astra", codexEffort: "xhigh" })]);
    const st = run(["lend", "status"]);
    expect(st).toMatchObject({ ok: true, lending: true, effective: [{ codexModel: "gpt-6-astra", codexEffort: "xhigh" }] });
    expect(st.message).toContain("team-a（codex 模型 gpt-6-astra · 推理档 xhigh）");
    expect(run(g("--codex-effort", "xhigh"), "222")).toMatchObject({ ok: false, code: "forbidden" });
    expect(lend()[0]).toMatchObject({ codexModel: "gpt-6-astra" });
    expect(run(g())).toMatchObject({ ok: true });
    expect(lend()[0]).not.toHaveProperty("codexModel");
    expect(lend()[0]).not.toHaveProperty("codexEffort");
    expect(run(["lend", "status"]).message).toBe("出借中：team-a");
  }, 60_000);
});
