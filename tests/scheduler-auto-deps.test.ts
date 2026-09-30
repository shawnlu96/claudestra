import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { openAsk } from "../src/lib/ledger-asks.js";
import { getTask } from "../src/lib/ledger-store.js";
import { autoTickDeps, reviewerName } from "../src/lib/scheduler-auto-deps.js";
import { acpPort, messagePort } from "../src/lib/scheduler-auto-ports.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const ref = (agent: string, sessionId: string, family: "claude" | "codex", transport: "acp" | "tmux" = "tmux"): SessionRef =>
  ({ taskId: "T1", role: "author", agent, sessionId, family, transport });

function withAgents(f: ReturnType<typeof autoFixture>, extra: Record<string, object>) {
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  Object.assign(reg.agents, extra);
  writeFileSync(f.registryPath, JSON.stringify(reg));
}

describe("T68f production deps (registry-driven, no network)", () => {
  test("route per bound session: Claude Code → channel, Codex ACP → acp, Codex on TUI → tmux with reason; Pi / missing / moved session → manual", () => {
    const f = autoFixture();
    try {
      withAgents(f, { "agent-cx-tui": { runtime: "codex", sessionId: "s-tui" }, "agent-pi": { runtime: "pi", sessionId: "s-pi" } });
      const d = autoTickDeps(f.db, { registryPath: f.registryPath });
      const route = (r: SessionRef) => { const w = d.worker(r); return "manual" in w ? `manual:${w.manual}` : `${w.route}:${w.fallbackReason ?? ""}`; };
      expect(route(ref("agent-task-one", "s-one", "claude"))).toBe("channel:");
      expect(route(ref("agent-rv-t1", "s-rv", "codex", "acp"))).toBe("acp:");
      expect(route(ref("agent-cx-tui", "s-tui", "codex"))).toBe("tmux:tmux 兼容回退：该 Codex 会话尚未迁到 ACP");
      expect(route(ref("agent-pi", "s-pi", "claude"))).toContain("manual:Pi 会话");
      expect(route(ref("agent-gone", "s", "claude"))).toBe("manual:agent-gone 不在本机 registry");
      expect(route(ref("agent-task-one", "s-old", "claude"))).toBe("manual:agent-task-one 的当前 session 已不是台账绑定的那个");
    } finally { f.close(); }
  });

  test("ensure: the author is the card's named executor; the reviewer is the per-card agent-rv-<task> of the other family", async () => {
    const f = autoFixture();
    try {
      const d = autoTickDeps(f.db, { registryPath: f.registryPath });
      const task = getTask(f.db, "T1")!;
      expect(await d.ensure(task, "author", "claude")).toMatchObject({ kind: "ready", created: false, ref: { agent: "agent-task-one", sessionId: "s-one", transport: "tmux" } });
      expect(await d.ensure(task, "author", "codex")).toMatchObject({ kind: "manual", reason: expect.stringContaining("不是要求的 codex 家族") });
      expect(await d.ensure({ ...task, agent: null }, "author", "claude")).toMatchObject({ kind: "manual", reason: expect.stringContaining("PM 指定执行者") });
      expect(reviewerName("T1")).toBe("agent-rv-t1");
      expect(await d.ensure(task, "reviewer", "codex")).toMatchObject({ kind: "ready", ref: { agent: "agent-rv-t1", sessionId: "s-rv", transport: "acp", role: "reviewer" } });
      withAgents(f, { "agent-rv-t1": { runtime: "codex", transport: "acp" } });
      expect(await d.ensure(task, "reviewer", "codex")).toMatchObject({ kind: "unknown", reason: "agent-rv-t1 还没有 session id" });
    } finally { f.close(); }
  });

  test("ports refuse before the bridge when the session moved; a Codex quota card is attributed to the last order sent before it", async () => {
    const f = autoFixture();
    try {
      const row = (a: string) => JSON.parse(readFileSync(f.registryPath, "utf8")).agents[a] && { name: a, ...JSON.parse(readFileSync(f.registryPath, "utf8")).agents[a] };
      expect(await messagePort(f.db, row).send("agent-task-one", "s-old", "x", "k")).toEqual({ ok: false, delivered: false, reason: "agent-task-one 的当前 session 不是台账绑定的 s-old" });
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      await f.tick();
      await f.tick();
      const sent = f.intents().at(-1)!;
      expect(sent).toMatchObject({ action: "review", status: "done", recipient: "agent-rv-t1" });
      const port = acpPort(f.db, row);
      expect((await port.turnState("agent-rv-t1", "s-moved")).lastFailure).toBeUndefined();
      const updated = (f.db.query("SELECT updatedAt FROM scheduler_intents WHERE id = ?").get(sent.id) as { updatedAt: number }).updatedAt;
      openAsk(f.db, { project: "p", source: "codex", kind: "decide", title: "Codex 额度用完了", fromAgent: "agent-rv-t1", extra: { quota: true, raw: "usage limit" } }, updated + 5);
      expect(await port.turnState("agent-rv-t1", "s-moved")).toEqual({ live: "offline",
        lastFailure: { failure: { kind: "quota", key: expect.any(String), message: "usage limit" }, afterKey: sent.id } });
    } finally { f.close(); }
  });
});
