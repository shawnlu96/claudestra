import { expect, test } from "bun:test";
import { FIX_MAIN_LINE, lendFixEnv, lendFixMaterials } from "../src/lib/lend-fix-env.js";
import { writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { renderOrderWire } from "../src/lib/order-wire-render.js";
import { bounceWork, type MergeBounce } from "../src/lib/scheduler-merge-conflict.js";

const H = "a".repeat(40), BASE = "b".repeat(40), RUN = "https://github.com/o/r/actions/runs/1";
const FETCH = "git fetch 后合入最新 origin/main", REF = "refs/remotes/origin/HEAD";
const task = { id: "T1", specRev: 1, round: 1 } as LedgerTask;
const ciFail: MergeBounce = { cause: "ci_fail", prHead: H.slice(0, 12), mainHead: null, checks: [{ name: "check", link: RUN }] };
const probe = { peerFp: async () => "abcd", remoteHead: async () => ({ ok: true as const, head: BASE }) };
const order = (step: "write" | "fix" | "review", extra: object = {}) => writeOrderWire(task, { orderId: `${step}:T1`, step: step as "fix", head: H,
  branch: "lend/T1-abcd", base: "main", spec: "规格", report: step === "fix" ? "P1 原文" : null, findings: [], repo: "o/r", pr: 7, ...extra });

test("ci_fail bounce lent to a peer: verified baseline replaces fetch, no full SHA leaves", async () => {
  const material = await lendFixMaterials("abcd", { repo: "o/r", base: "main" }, probe);
  const wire = order("fix", { report: material.report, bounce: bounceWork(ciFail) });
  expect(wire.acceptance).toContain(`PR 落后 main 时，先 核对基线后合入 ${REF}，再看 CI 红是否仍在`);
  expect(wire.acceptance).toContain("副本禁止 fetch、禁止改 git 配置；基线核对通过后才能合入");
  expect(wire.acceptance).not.toContain(FIX_MAIN_LINE);
  const env = wire.inputs.filter((s) => s.startsWith("远端工作副本环境："));
  expect(env).toHaveLength(1);
  expect(env[0]).toContain(`用 git rev-parse ${REF} 核对 SHA 前 12 位等于 ${BASE.slice(0, 12)}`);
  expect(wire.inputs.some((s) => s.startsWith("冲突单还须核对"))).toBe(false);
  for (const text of [[...wire.inputs, ...wire.acceptance, ...wire.outputs, wire.writeBack].join("\n"), renderOrderWire(wire, { audience: "peer", ledgerHead: H }).replace(`head：${H}\n`, "")]) {
    expect(text).not.toContain("git fetch");
    expect(text).not.toMatch(/[a-f0-9]{40}/i);
    expect(text).not.toContain("推送后报新 head");
    expect(text).toContain(BASE.slice(0, 12));
  }
});

test("ci_fail bounce for a local executor: fetch-and-merge line comes first, exactly once", () => {
  const work = bounceWork(ciFail);
  expect(work.acceptance).toEqual([`PR 落后 main 时，先 ${FETCH}，再看 CI 红是否仍在`, "看 CI 日志定位原因并修好", "本机 tsc、guard、相关测试通过",
    "推送后报新 head；这一轮不算 P1 修复"]);
  expect([...work.inputs, ...work.acceptance].join("\n").split(FETCH)).toHaveLength(2);
  expect(work.inputs).toEqual([`PR 头 CI 失败：check（${RUN}），看日志修好后推送`]);
});

test("lent fix without a merge bounce carries the fixed main line; write and review orders do not", () => {
  const fix = order("fix");
  expect(fix.acceptance.filter((s) => s === FIX_MAIN_LINE)).toHaveLength(1);
  expect(fix.acceptance.at(-1)).toBe(FIX_MAIN_LINE);
  expect(FIX_MAIN_LINE).toBe(`副本禁止 fetch。规格或审查要求合入 main 时，用 git rev-parse ${REF} 核对前 12 位，等于规格里 PM 写的核对值才合入这个 ref；规格没写核对值就不合，交付说明里写明。`);
  expect(FIX_MAIN_LINE).not.toMatch(/[a-f0-9]{7,}/i);
  expect(FIX_MAIN_LINE).not.toContain("git fetch");
  expect(fix.inputs.some((s) => s.startsWith("远端工作副本环境："))).toBe(false);
  expect(renderOrderWire(fix, { audience: "peer", ledgerHead: H })).toContain("规格没写核对值就不合");
  expect(lendFixEnv(fix, null, null)).toBe(fix);
  expect(lendFixEnv(fix, undefined, null).acceptance.filter((s) => s === FIX_MAIN_LINE)).toHaveLength(1);
  for (const wire of [order("write"), order("write", { resume: true }), order("review")]) {
    expect(wire.acceptance.join("\n")).not.toContain("规格里 PM 写的核对值");
    expect(lendFixEnv(wire, null, null)).toBe(wire);
  }
  // A bounce passed to a non-fix step is dropped by the order builder, and still earns no line.
  expect(order("write", { bounce: bounceWork(ciFail) }).acceptance.join("\n")).not.toContain("核对");
});

test("conflict and update_fail lent wires stay byte for byte as before", async () => {
  const material = await lendFixMaterials("abcd", { repo: "o/r", base: "main" }, probe);
  const env = `远端工作副本环境：本机查询基线 main 的 SHA 前 12 位为 ${BASE.slice(0, 12)}；用 git rev-parse ${REF} 核对 SHA 前 12 位等于 ${BASE.slice(0, 12)}；` +
    "基线 ref 缺失或 SHA 不符就停止并交回本机处理，不自行猜测基线。";
  const tail = "副本禁止 fetch、禁止改 git 配置；基线核对通过后才能合入";
  const conflict = order("fix", { report: material.report, bounce: bounceWork({ cause: "conflict", prHead: H.slice(0, 12), mainHead: BASE.slice(0, 12), checks: [] }) });
  expect(conflict.acceptance.slice(2)).toEqual([`核对基线后合入 ${REF}`, "只 git add 冲突文件，两边的改动都保留", "本机 tsc、guard、相关测试通过",
    "提交后用 deliver 报新 head，由出借服务推送；不读审查报告，这一轮不算 P1 修复", tail]);
  expect(conflict.inputs.slice(-3)).toEqual([expect.stringContaining("标准答复"), env, "冲突单还须核对 ref 的 SHA 与退回原因中的 main SHA 一致；不一致就停止并交回本机处理"]);
  expect(conflict.inputs).toContain(`解冲突：PR head ${H.slice(0, 12)} 和 main（${BASE.slice(0, 12)}）冲突，合并队列已退回`);
  const update = order("fix", { report: material.report, bounce: bounceWork({ cause: "update_fail", prHead: H.slice(0, 12), mainHead: null, checks: [], error: "HTTP 422" }) });
  expect(update.acceptance.slice(2)).toEqual([`核对基线后合入 ${REF}，有冲突只 git add 冲突文件、两边的改动都保留`, "本机 tsc、guard、相关测试通过",
    "提交后用 deliver 报新 head，由出借服务推送；不读审查报告，这一轮不算 P1 修复", tail]);
  expect(update.inputs.slice(-2)).toEqual([expect.stringContaining("标准答复"), env]);
  expect(update.inputs).toContain(`更新分支失败：PR head ${H.slice(0, 12)} 没能自动合入 main（HTTP 422），合并队列已退回`);
});
