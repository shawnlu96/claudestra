/**
 * 上下文边界的注入闸接 T35 的 lp-state：paneQuotaState(plain, escaped)（一次 -e 抓屏，plain 是它去色后的样子）。
 * 样本是 T35 的 fixtures/lp/：input-*（私有 tmux 里真实 CC 2.1.283 的输入框）、modal-*（沙箱抓的权限框 / AUQ / Rewind）；
 * 长草稿 / bash 模式 / 草稿里的整行横线从空框样本改出来。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { paneQuotaState, stripAnsi } from "../src/lib/lp-state.js";
import { ctxBoundaryTick, injectCompact, resetCtxBoundaryState, type BoundaryAgent, type CtxBoundaryDeps } from "../src/bridge/ctx-boundary.js";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures/lp", `${n}.ansi`), "utf8");
const state = (raw: string) => paneQuotaState(stripAnsi(raw), raw);

/** 把空框样本里「❯ 灰色提示」那一行换成给定的几行（模拟各种输入框内容） */
function withInput(lines: string[]): string {
  return fx("input-suggestion")
    .split("\n")
    .flatMap((l) => (l.includes("❯") && l.includes("\x1b[2m") ? lines : [l]))
    .join("\n");
}

describe("注入闸看到的画面（真实样本）", () => {
  test("空框（只有灰色提示）→ 不挡", () => {
    const s = state(fx("input-suggestion"));
    expect([s.draft, s.menu, s.wall, s.compacting]).toEqual([false, false, false, false]);
  });
  test("单行 / 多行草稿 → 草稿", () => {
    expect(state(fx("input-draft")).draft).toBe(true);
    expect(state(fx("input-draft-multiline")).draft).toBe(true);
  });
  test("权限框 / AUQ / Rewind → 挡（menu 或 draft 至少一个为真）", () => {
    for (const f of ["modal-permission", "modal-auq", "modal-rewind"]) {
      const s = state(fx(f));
      expect(s.menu || s.draft).toBe(true);
    }
  });
});

describe("认不出的输入框一律当草稿", () => {
  const cases: [string, string[]][] = [
    ["14 行以上的长草稿", ["\x1b[39m❯\xa0line 1", ...Array.from({ length: 15 }, (_, i) => `  line ${i + 2}`)]],
    ["bash 模式（! 提示符）", ["\x1b[39m!\xa0ls -la"]],
    ["草稿里带整行横线", ["\x1b[39m❯\xa0above", "  " + "─".repeat(60), "  below"]],
  ];
  for (const [name, lines] of cases) test(name, () => expect(state(withInput(lines)).draft).toBe(true));
  test("只有纯文本（没带 -e）分不清灰字和草稿 → 也当草稿", () => {
    const plain = stripAnsi(fx("input-suggestion"));
    expect(paneQuotaState(plain, "").draft).toBe(true);
  });
});

describe("执行器接上真实判定：草稿 / 对话框过硬上限也一个键都不敲", () => {
  function run(raw: string) {
    resetCtxBoundaryState();
    const sent: string[] = [];
    const a: BoundaryAgent = { name: "agent-task-t1", projectId: null, target: "master:agent-task-t1", executor: true, ctx: 400_000, convTs: 0, mtime: 0, realWindow: null };
    const deps: CtxBoundaryDeps = {
      now: () => 1_000_000_000,
      agents: async () => [a],
      capture: async () => ({ plain: stripAnsi(raw), esc: raw }),
      paneState: paneQuotaState,
      send: async (_t, line) => void sent.push(line),
      autoCompact: () => undefined,
      log: () => {},
      gateGlobal: true,
    };
    return { deps, sent, a };
  }
  test("空框 → 硬上限照常注入", async () => {
    const { deps, sent } = run(fx("input-suggestion"));
    expect((await ctxBoundaryTick(deps))[0].verdict).toEqual({ fire: true, kind: "hard-cap" });
    expect(sent.length).toBe(1);
  });
  test("草稿 / 长草稿 / bash 模式 / 权限框 / AUQ / Rewind → 不发", async () => {
    const screens = [
      fx("input-draft"),
      fx("input-draft-multiline"),
      withInput(["\x1b[39m!\xa0ls -la"]),
      withInput(["\x1b[39m❯\xa0l1", ...Array.from({ length: 15 }, () => "  x")]),
      fx("modal-permission"),
      fx("modal-auq"),
      fx("modal-rewind"),
    ];
    for (const raw of screens) {
      const { deps, sent, a } = run(raw);
      const v = (await ctxBoundaryTick(deps))[0].verdict;
      expect(v.fire).toBe(false);
      expect(await injectCompact(a, { action: "compact" }, deps)).toMatchObject({ status: "skipped" });
      expect(sent.length).toBe(0);
    }
  });
});
