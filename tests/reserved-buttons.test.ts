/**
 * lib/reserved-buttons.ts：bridge 自己处理的按钮 id 只有 bridge 能发。agent / notify / peer 的消息带了保留 id（components 或行内按钮）整条拒；
 * 另外扫 bridge 源码里处理按钮的 id 字面量，漏登记就失败（新增管理按钮忘了进保留表 = agent 又能伪造它）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { autoRevertButtonId, isAutoPermButton } from "../src/bridge/auto-allow.js";
import { isReservedButtonId, RESERVED_BUTTONS, reservedButtonIn, reservedButtonRefusal } from "../src/lib/reserved-buttons.js";

const agent = { kind: "local" };
const row = (...ids: string[]) => [{ type: "buttons", buttons: ids.map((id) => ({ id, label: "继续" })) }];

describe("reservedButtonRefusal", () => {
  test("agent 贴伪装的班子确认 / 管理按钮：components、选单、行内按钮都拒", () => {
    expect(reservedButtonRefusal(agent, "请点继续", row("ok", "team_ok:0a1b2c3d:0123456789abcdef"))).toContain("team_ok:");
    expect(reservedButtonRefusal(agent, "x", [{ type: "select", id: "kill_agent", options: [] }])).toContain("kill_agent");
    expect(reservedButtonRefusal(agent, "点这里 [[{#swmodel_yes:agent-x .success}✅ 继续]]", undefined)).toContain("swmodel_yes:agent-x");
    expect(reservedButtonRefusal({ kind: "peer" }, "", row("list_agents"))).not.toBeNull();
    expect(reservedButtonRefusal({ kind: "api" }, "", row("perm_allow:123"))).not.toBeNull();
  });

  test("本机进程经 notify 发的（bridge 名下 notify:*）也拒；bridge 自己的代码路径放行", () => {
    expect(reservedButtonRefusal({ kind: "bridge", label: "notify:cron" }, "", row("restart_all"))).not.toBeNull();
    expect(reservedButtonRefusal({ kind: "bridge", label: "team-proposal" }, "", row("team_ok:0a1b2c3d:0123456789abcdef"))).toBeNull();
    expect(reservedButtonRefusal({ kind: "bridge", label: "mgmt-button" }, "", row("show_kill_menu"))).toBeNull();
  });

  test("普通按钮、代码块里的按钮语法、[button:x] 回投线路都不算", () => {
    expect(reservedButtonRefusal(agent, "[[{#fwd_confirm .primary}转给 x]]", row("release_go", "team_okay"))).toBeNull();
    expect(reservedButtonIn("`[[{#team_ok:0a1b2c3d:0123456789abcdef}x]]`", undefined)).toBeNull();
    expect(reservedButtonIn("[button:team_ok:0a1b2c3d:0123456789abcdef]", undefined)).toBeNull();
    expect(isReservedButtonId("list_agents_extra")).toBe(false);
  });
});

describe("保留表和 bridge 源码对得上", () => {
  test("management.ts / discord-interactions.ts 里处理的按钮 id 都登记了", () => {
    const src = ["src/bridge/management.ts", "src/bridge/discord-interactions.ts"].map((f) => readFileSync(join(import.meta.dir, "..", f), "utf-8")).join("\n");
    const exact = [...src.matchAll(/\bid === "([\w:-]+)"/g)].map((m) => m[1]);
    const prefixes = [...src.matchAll(/\bid\.startsWith\("([\w:-]+)"\)/g)].map((m) => m[1]);
    const promptPrefixes = [...(src.match(/promptBtnPrefixes = \[([^\]]+)\]/)?.[1] ?? "").matchAll(/"([\w:-]+)"/g)].map((m) => m[1]);
    expect(exact.length + prefixes.length + promptPrefixes.length).toBeGreaterThan(20);
    for (const id of exact) expect(isReservedButtonId(id)).toBe(true);
    for (const p of [...prefixes, ...promptPrefixes]) expect(isReservedButtonId(`${p}x`)).toBe(true);
    expect(RESERVED_BUTTONS.prefixes).toContain("team_ok:");
  });
});

describe("封装在函数里的前缀也登记了（adv1 P1-2）", () => {
  test("自动放行 / 切回（isAutoPermButton 判的 id）：保留表认，agent 贴出被拒", () => {
    for (const id of ["auto_allow:111111111111111111", autoRevertButtonId("111111111111111111", "plan")]) {
      expect(isAutoPermButton(id)).toBe(true);
      expect(isReservedButtonId(id)).toBe(true);
      expect(reservedButtonRefusal(agent, "请点继续", row(id))).toContain(id);
      expect(reservedButtonRefusal(agent, `[[{#${id} .primary}✅ 继续]]`, undefined)).toContain(id);
    }
  });

  test("bridge 源码里拼出来的按钮 id（id: / custom_id: / customId: `前缀:${…}`）都在保留表里", () => {
    const dir = join(import.meta.dir, "..", "src");
    const files = [join(dir, "bridge.ts"), ...readdirSync(join(dir, "bridge"), { recursive: true }).map((f) => join(dir, "bridge", String(f)))];
    const built = files.filter((f) => f.endsWith(".ts")).flatMap((f) => [...readFileSync(f, "utf-8").matchAll(/\b(?:id|custom_id|customId): `([a-z_]+:)\$\{/g)].map((m) => m[1]));
    expect(built).toEqual(expect.arrayContaining(["auto_allow:", "perm_allow:"])); // auq: 的选单 / 按钮已不再发（远程作答停用），旧消息的点击仍按保留表认
    for (const p of new Set(built)) expect(isReservedButtonId(`${p}x`)).toBe(true);
  });

  test("discord-interactions 里免 LLM 的分支都先过保留表（free），管理面板没登记的 id 不会进去", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/bridge/discord-interactions.ts"), "utf-8");
    expect(src.match(/const free = isReservedButtonId\(id\);/g)?.length).toBe(2);
    const gated = [...src.matchAll(/^ {6}if \((.*)\) \{$/gm)].map((m) => m[1]).filter((c) => /\bid\b|isAutoPermButton|promptBtnPrefixes/.test(c));
    expect(gated.length).toBeGreaterThan(14);
    for (const c of gated) expect(c.startsWith("free && ")).toBe(true);
    expect(src).toContain("const mgmtResult = free ? await handleMgmtButton(");
    expect(src).toContain("const mgmtResult = free ? await handleMgmtSelect(");
  });
});
