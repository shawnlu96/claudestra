/**
 * lib/reserved-buttons.ts：bridge 自己处理的按钮 id 只有 bridge 能发。agent / notify / peer 的消息带了保留 id（components 或行内按钮）整条拒；
 * 另外扫 bridge 源码里处理按钮的 id 字面量，漏登记就失败（新增管理按钮忘了进保留表 = agent 又能伪造它）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
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
