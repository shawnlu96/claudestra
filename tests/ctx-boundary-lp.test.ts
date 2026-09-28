/**
 * 上下文边界接 T35 的 lp-state：readLpPane（一次 -e 抓屏）→ paneStateFromLp → 注入闸。
 * fixtures/ctx-boundary/ 是私有 tmux 里起真实 CC 界面抓的（2.1.283，没发消息）；长草稿 / bash 模式 / 草稿里的整行横线从空框样本改出来。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { readLpPane } from "../src/lib/lp-state.js";
import { paneStateFromLp } from "../src/lib/ctx-boundary-decision.js";
import { ctxBoundaryTick, injectCompact, resetCtxBoundaryState, type BoundaryAgent, type CtxBoundaryDeps } from "../src/bridge/ctx-boundary.js";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures/ctx-boundary", `${n}.ansi`), "utf8");
const state = (raw: string) => paneStateFromLp(readLpPane(raw));

/** 把空框样本里「❯ 灰色提示」那一行换成给定的几行（模拟各种输入框内容） */
function withInput(lines: string[]): string {
  return fx("empty")
    .split("\n")
    .flatMap((l) => (l.includes("❯") && l.includes("\x1b[2m") ? lines : [l]))
    .join("\n");
}

describe("paneStateFromLp：真实样本", () => {
  test("空框（只有灰色提示）→ 不算草稿，也不挡", () => {
    expect(state(fx("empty"))).toEqual({ wall: false, lp: "off", exhausted: false, menu: false, compacting: false, draft: false });
  });
  test("单行 / 多行草稿 → 草稿", () => {
    expect(state(fx("draft")).draft).toBe(true);
    expect(state(fx("draft-multiline")).draft).toBe(true);
  });
});

describe("认不出的输入框一律当草稿（unknown 也算）", () => {
  const cases: [string, string[]][] = [
    ["14 行以上的长草稿", ["\x1b[39m❯\xa0line 1", ...Array.from({ length: 15 }, (_, i) => `  line ${i + 2}`)]],
    ["bash 模式（! 提示符）", ["\x1b[39m!\xa0ls -la"]],
    ["草稿里带整行横线", ["\x1b[39m❯\xa0above", "  " + "─".repeat(60), "  below"]],
  ];
  for (const [name, lines] of cases) {
    test(name, () => {
      const r = readLpPane(withInput(lines));
      expect(r.input).not.toBe("empty");
      expect(state(withInput(lines)).draft).toBe(true);
    });
  }
  test("有排队消息（输入框本身空）→ 不算草稿；自动压缩那边另由「已排队」一步挡住", () => {
    const raw = withInput(["\x1b[39m❯\xa0/compact x", "  Press up to edit queued messages"]);
    expect(readLpPane(raw).input).toBe("queued");
    expect(state(raw).draft).toBe(false);
  });
  test("纯文本（没带 -e）分不清灰字和草稿 → 也当草稿", () => {
    expect(state(fx("empty").replace(/\x1b\[[0-9;]*m/g, "")).draft).toBe(true);
  });
});

describe("接上真实判定后的执行器：长草稿 / bash 模式过硬上限也不注入", () => {
  function run(raw: string) {
    resetCtxBoundaryState();
    const sent: string[] = [];
    const a: BoundaryAgent = { name: "agent-task-t1", projectId: null, target: "master:agent-task-t1", executor: true, ctx: 400_000, convTs: 0, mtime: 0, realWindow: null };
    const deps: CtxBoundaryDeps = {
      now: () => 1_000_000_000,
      agents: async () => [a],
      capture: async () => ({ plain: raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""), esc: raw }),
      paneState: (esc) => state(esc),
      send: async (_t, line) => void sent.push(line),
      autoCompact: () => undefined,
      log: () => {},
      gateGlobal: true,
    };
    return { deps, sent, a };
  }
  test("空框样本 → 硬上限照常注入", async () => {
    const { deps, sent } = run(fx("empty"));
    expect((await ctxBoundaryTick(deps))[0].verdict).toEqual({ fire: true, kind: "hard-cap" });
    expect(sent.length).toBe(1);
  });
  test("各种草稿 → 跳过（草稿），一个键都不敲", async () => {
    for (const raw of [fx("draft"), fx("draft-multiline"), withInput(["\x1b[39m!\xa0ls -la"]), withInput(["\x1b[39m❯\xa0l1", ...Array.from({ length: 15 }, () => "  x")])]) {
      const { deps, sent, a } = run(raw);
      expect((await ctxBoundaryTick(deps))[0].verdict).toEqual({ fire: false, reason: "draft" });
      expect(await injectCompact(a, { action: "compact" }, deps)).toMatchObject({ status: "skipped", reason: "draft" });
      expect(sent.length).toBe(0);
    }
  });
});
