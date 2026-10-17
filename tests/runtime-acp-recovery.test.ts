/**
 * OCR-2 验收追加 7 第 2 条：ACP 起不来时的恢复按运行时的真实能力判。只走 ACP 的 OpenCode：零回退、零 transport 改写、不退宿主；
 * 有 tmux 版的 Codex / Pi：照旧退宿主、改写成 tmux、在同一窗口起 TUI 版。
 */
import { expect, test } from "bun:test";
import { managedFor } from "../src/lib/runtimes/index.ts";
import { recoverFailedAcpLaunch } from "../src/manager/acp-lifecycle.ts";

function rig(runtime: string) {
  const state: Record<string, unknown> = { runtime, transport: "acp", status: "active" };
  const calls = { exits: 0, patches: 0, launches: [] as string[] };
  const deps = {
    exit: async () => (calls.exits++, true),
    patch: async (_name: string, mutate: (a: never) => void) => (calls.patches++, mutate(state as never), true),
  };
  const launch = async (a: { registryFields: (s: never) => Record<string, unknown> }) => (calls.launches.push(String(a.registryFields({} as never).transport ?? "tmux")), { ready: true as const });
  return { state, calls, deps, launch };
}

test("OpenCode 接会话失败：如实报失败，不退宿主、不改写 transport、不再起", async () => {
  const r = rig("opencode");
  const out = await recoverFailedAcpLaunch("agent-oc", r.state, managedFor("opencode", "acp")!, { ready: false, reason: "timeout" }, r.launch as never, r.deps as never);
  expect(out.started).toEqual({ ready: false, reason: "timeout" });
  expect(out.adapter).toBe(managedFor("opencode", "acp")!);
  expect(r.calls).toEqual({ exits: 0, patches: 0, launches: [] });
  expect(r.state).toEqual({ runtime: "opencode", transport: "acp", status: "active" });
});

test("OpenCode 启动命令就抛：原样抛出（不当成可回退的失败）", async () => {
  const r = rig("opencode");
  await expect(recoverFailedAcpLaunch("agent-oc", r.state, managedFor("opencode", "acp")!, Promise.reject(new Error("缺模型")), r.launch as never, r.deps as never))
    .rejects.toThrow("缺模型");
  expect(r.calls).toEqual({ exits: 0, patches: 0, launches: [] });
});

for (const runtime of ["codex", "pi"]) {
  test(`${runtime} 接会话失败：照旧退宿主、改写成 tmux、起 TUI 版`, async () => {
    const r = rig(runtime);
    const out = await recoverFailedAcpLaunch(`agent-${runtime}`, r.state, managedFor(runtime, "acp")!, { ready: false, reason: "timeout" }, r.launch as never, r.deps as never);
    expect(out.started.ready).toBe(true);
    expect(out.adapter).toBe(managedFor(runtime, "tmux")!);
    expect(r.calls.exits).toBe(1);
    expect(r.calls.launches).toEqual(["tmux"]);
    expect(r.state).toMatchObject({ transport: "tmux", acpPending: true });
    expect(r.state.acpRestartPending).toBeUndefined();
  });
}
