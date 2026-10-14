import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPmRoute } from "../src/lib/pm-route.js";
import { asInfo, pmNoticeLevel } from "../src/lib/pm-notice-level.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { routePmPush } from "../src/lib/pm-route-delivery.js";
import type { DigestInput } from "../src/lib/pm-digest.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sched = (body: string, level?: DigestInput["level"]): DigestInput =>
  ({ fromKind: "local", sender: "scheduler", intent: "request", triggerKind: "agent_tool", oneShot: true, body, ...(level ? { level } : {}) });
const rule = (m: DigestInput) => classifyPmRoute(m).tags[0].rule;

test("the sender's level decides, not the wording: info never wakes the PM, action always does, in any language", () => {
  const zh = "[调度引擎] 卡 worktree 下有 2 个残留进程（请 PM 看；要回收：ledger …）";
  expect(rule(sched(zh))).toBe("protect.action"); // 没标级别：沿用旧规则，正文字样把它判成要紧
  expect(classifyPmRoute(sched(zh, "info"))).toEqual({ tags: [{ route: "digest", rule: "level.info", reason: "发送方标为常规" }], digest: true });
  const en = "[engine] card a-T1 handed back to manual, please take over";
  expect(classifyPmRoute(sched(en, "action"))).toEqual({ tags: [{ route: "judge", rule: "level.action", reason: "发送方标为要 PM 动手" }], immediate: true });
  expect(rule(sched("[engine] 2 leftover processes under the card worktree, please have a look", "info"))).toBe("level.info");
});

test("owner, human and card answers are never demoted by a level", () => {
  expect(rule({ ...sched("x", "info"), fromKind: "api" })).toBe("protect.owner");
  expect(rule({ ...sched("x", "info"), triggerKind: "ask_answer" })).toBe("protect.answer");
});

test("asInfo carries the level across awaits to the notice sender", async () => {
  const seen = await asInfo(async () => { await Promise.resolve(); return pmNoticeLevel.getStore(); });
  expect(seen).toBe("info");
  expect(pmNoticeLevel.getStore()).toBeUndefined();
});

test("an info push with route + digest on is queued, not delivered; an action push is delivered", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-level-"));
  dirs.push(dir);
  const store = new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
  store.setMode("p", "on");
  store.setRouteMode("p", "on");
  const env = (pmLevel: "action" | "info", id: string) => ({ from: { kind: "local" as const }, intent: "request", content: "[engine] please look",
    meta: { messageId: id, triggerKind: "agent_tool", skipInterAgentWatchdog: true, pmLevel } });
  const deps = { store, now: () => 1 };
  expect(routePmPush(env("info", "m1"), "p", deps, () => false, "[engine] please look", "scheduler")).toBe(true);
  expect(store.queued("p").map((e) => e.id)).toEqual(["m1"]);
  expect(routePmPush(env("action", "m2"), "p", deps, () => false, "[engine] please look", "scheduler")).toBe(false);
});
