import { afterEach, expect, spyOn, test } from "bun:test";
import * as bridge from "../src/lib/bridge-client.js";
import * as tmux from "../src/lib/tmux-helper.js";
import { finishedWorkerIdle } from "../src/lib/ledger-scheduler-lease-worker.js";
import type { RegistryAgent } from "../src/lib/registry.js";

const restore: (() => void)[] = [];
afterEach(() => { for (const fn of restore.splice(0).reverse()) fn(); });
const worker: RegistryAgent = { name: "agent-test", sessionId: "test-session", status: "active", transport: "acp" };

test("ACP only an explicit idle response releases; busy, unknown, missing and timeout all hold", async () => {
  const query = spyOn(bridge, "bridgeRequest");
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  restore.push(() => query.mockRestore(), () => errors.mockRestore());
  for (const turn of ["busy", "unknown", null, "idle"]) {
    query.mockResolvedValueOnce({ turns: { [worker.name]: turn } });
    expect(await finishedWorkerIdle(worker)).toBe(turn === "idle");
  }
  query.mockRejectedValueOnce(new Error("Bridge 请求超时"));
  expect(await finishedWorkerIdle(worker)).toBe(false);
  query.mockResolvedValueOnce({ turns: { [worker.name]: "idle" } });
  expect(await finishedWorkerIdle(worker)).toBe(true);
  expect(query).toHaveBeenLastCalledWith({ type: "turn_status", agents: [worker.name] }, { timeoutMs: 5000 });
});

test("creating or changing sessions never count as idle", async () => {
  for (const patch of [{ status: "creating" }, { sessionId: undefined }, { acpRestartPending: true }]) {
    expect(await finishedWorkerIdle({ ...worker, ...patch })).toBe(false);
  }
});

test("tmux requires a recognized idle prompt; blank, busy, dialog and unfamiliar panes hold", async () => {
  const capture = spyOn(tmux, "tmuxRaw");
  restore.push(() => capture.mockRestore());
  const prompt = "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m";
  for (const [pane, idle] of [[prompt, true], ["", false], ["unrecognized screen", false],
    [`• Working (6s • esc to interrupt)\n${prompt}`, false], [`${prompt}\n1 background terminal running`, false],
    ["Do you trust the contents of this directory?\n› 1. Yes, continue", false]] as const) {
    capture.mockResolvedValueOnce(pane);
    expect(await finishedWorkerIdle({ ...worker, transport: "tmux", runtime: "codex" })).toBe(idle);
  }
  expect(capture).toHaveBeenLastCalledWith(["capture-pane", "-t", tmux.windowTarget(worker.name), "-p", "-e"], { timeoutMs: 5000 });
});

test("Claude and Pi idle prompts release, while active work and background activity keep the lock", async () => {
  const capture = spyOn(tmux, "tmuxRaw");
  restore.push(() => capture.mockRestore());
  const rule = "─".repeat(80);
  const footer = [rule, "❯ ", rule, "  Opus 5.5 · ctx 96%", "  ⏵⏵ bypass permissions on"].join("\n");
  const piFooter = [rule, rule, "~/projects/x • agent-pi", "↑17M ↓2.8M", "🔗 agent-pi 💬 pi--10"].join("\n");
  for (const [runtime, pane, idle] of [
    ["claude-code", `✻ Worked for 46s · done\n${footer}`, true],
    ["claude-code", `✽ Recombobulating… (12s · ↓ 1.2k tokens)\n${footer}`, false],
    ["claude-code", `${footer}\n  ◯ general-purpose  Anal… 1m 13s · ↓ 58.1k tokens`, false],
    ["pi", `done\n${piFooter}`, true],
    ["pi", "unrecognized", false],
  ] as const) {
    capture.mockResolvedValueOnce(pane);
    expect(await finishedWorkerIdle({ ...worker, transport: "tmux", runtime })).toBe(idle);
  }
});
