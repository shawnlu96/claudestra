/**
 * D5-4：Discord 交互块从 bridge.ts 搬到 bridge/discord-interactions.ts + bridge/slash-commands.ts
 * 之后的接缝约束（纯搬移，行为零变化）：
 * - import 时零副作用，只导出注册函数；
 * - registerInteractionHandlers 只挂一个 interactionCreate 监听；
 * - 门禁（fail-closed allowlist）每次交互现取 deps.allowedDiscordIds()，不是注册时的快照；
 * - src/bridge/**、src/lib/** 不反向 import bridge.ts（它的顶层会连 Discord / 起 Bun.serve）。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { registerInteractionHandlers, type InteractionDeps } from "../src/bridge/discord-interactions";
import * as slashCommands from "../src/bridge/slash-commands";

type Listener = (...args: any[]) => unknown;

function fakeDiscord() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    on(ev: string, fn: Listener) {
      listeners.set(ev, [...(listeners.get(ev) || []), fn]);
      return this;
    },
  };
}

function fakeDeps(allow: string[]) {
  const calls = { allowed: 0, deliver: 0, typing: 0, rotation: 0 };
  const deps: InteractionDeps = {
    allowedDiscordIds: () => {
      calls.allowed++;
      return allow;
    },
    clients: new Map(),
    controlChannelId: "",
    deliver: async () => {
      calls.deliver++;
      throw new Error("deliver should not be called");
    },
    startTypingWithSafety: () => {
      calls.typing++;
    },
    scheduleClearRotation: () => {
      calls.rotation++;
    },
    runManager: async () => {
      throw new Error("runManager should not be called");
    },
    buildStatusPanel: async () => ({ text: "", components: [] }),
    handleMgmtButton: async () => null,
    handleMgmtSelect: async () => null,
  };
  return { deps, calls };
}

function fakeInteraction(userId: string, channelId: string | null = "c1") {
  const touched: string[] = [];
  const it: any = {
    type: 3,
    channelId,
    user: { id: userId, username: "u" },
    isChatInputCommand: () => (touched.push("isChatInputCommand"), false),
    isButton: () => (touched.push("isButton"), false),
    isStringSelectMenu: () => (touched.push("isStringSelectMenu"), false),
  };
  return { it, touched };
}

describe("discord-interactions 接缝", () => {
  test("只挂一个 interactionCreate 监听，别的事件不碰", () => {
    const d = fakeDiscord();
    registerInteractionHandlers(d as any, fakeDeps(["u1"]).deps);
    expect([...d.listeners.keys()]).toEqual(["interactionCreate"]);
    expect(d.listeners.get("interactionCreate")!.length).toBe(1);
  });

  test("allowlist 为空 → fail-closed，不进任何分支", async () => {
    const d = fakeDiscord();
    const { deps, calls } = fakeDeps([]);
    registerInteractionHandlers(d as any, deps);
    const { it, touched } = fakeInteraction("u1");
    await d.listeners.get("interactionCreate")![0](it);
    expect(calls.allowed).toBe(1);
    expect(touched).toEqual([]);
    expect(calls.deliver).toBe(0);
  });

  test("不在 allowlist 的用户被拒；allowlist 每次交互现取", async () => {
    const d = fakeDiscord();
    const { deps, calls } = fakeDeps(["someone-else"]);
    registerInteractionHandlers(d as any, deps);
    const fire = d.listeners.get("interactionCreate")![0];
    const a = fakeInteraction("u1");
    await fire(a.it);
    const b = fakeInteraction("u1");
    await fire(b.it);
    expect(calls.allowed).toBe(2);
    expect(a.touched).toEqual([]);
    expect(b.touched).toEqual([]);
  });

  test("没有 channelId 的交互直接忽略（不读 allowlist）", async () => {
    const d = fakeDiscord();
    const { deps, calls } = fakeDeps(["u1"]);
    registerInteractionHandlers(d as any, deps);
    const { it, touched } = fakeInteraction("u1", null);
    await d.listeners.get("interactionCreate")![0](it);
    expect(calls.allowed).toBe(0);
    expect(touched).toEqual([]);
  });

  test("slash-commands 只导出 registerSlashCommands（hash 去重状态不外泄）", () => {
    expect(Object.keys(slashCommands).sort()).toEqual(["registerSlashCommands"]);
  });
});

describe("反向依赖护栏", () => {
  test("src/bridge/**、src/lib/** 不 import bridge.ts", () => {
    const root = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /from\s+["']\.\.\/bridge(\.js|\.ts)?["']|import\(\s*["']\.\.\/bridge(\.js|\.ts)?["']/.test(readFileSync(p, "utf8"))) {
          offenders.push(p.slice(root.length + 1));
        }
      }
    };
    walk(join(root, "bridge"));
    walk(join(root, "lib"));
    expect(offenders).toEqual([]);
  });
});
