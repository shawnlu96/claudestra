/** 内置角色（roles/*.md + src/lib/team-roles.ts）：文件合法、公开发布不含个人信息 / 本机路径、按角色落盘与启动参数 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildClaudeCommand } from "../src/lib/claude-launch.js";
import { materializeRole, parseRole, renderRole, REVIEWER_AGENT, roleLaunch } from "../src/lib/team-roles.js";
import { keepOnResume, resolveTeamFields } from "../src/manager/team.js";

const ROLES_DIR = join(import.meta.dir, "..", "roles");
const FILES = ["pm", "dispatcher", "reviewer", "adversarial-reviewer", "executor"];

describe("roles/*.md", () => {
  test("五个角色文件都在，frontmatter 合法，名字与启动参数约定一致", () => {
    expect(readdirSync(ROLES_DIR).sort()).toEqual(FILES.map((f) => `${f}.md`).sort());
    const names = FILES.map((f) => parseRole(readFileSync(join(ROLES_DIR, `${f}.md`), "utf-8")).name);
    expect(names).toEqual(["claudestra-pm", "claudestra-dispatcher", REVIEWER_AGENT.regular, REVIEWER_AGENT.adversarial, "claudestra-executor"]);
  });

  test("公开发布：没有本机路径、用户名、邮箱、内网地址，也没有具体 agent 名", () => {
    const bad = [/\/Users\//, /\/private\//, /\/tmp\//, /~\/\./, /\bshawn/i, /@[\w-]+\.(com|io|dev)/, /\b100\.\d+\.\d+\.\d+/, /agent-claudestra/, /agent-pm-dispatch/];
    for (const f of FILES) {
      const md = readFileSync(join(ROLES_DIR, `${f}.md`), "utf-8");
      for (const re of bad) expect({ f, hit: re.test(md) ? re.source : null }).toEqual({ f, hit: null });
    }
  });

  test("都写了不在 owner 屏幕上做 UI 自动化；只用认识的占位符", () => {
    for (const f of FILES) {
      const md = readFileSync(join(ROLES_DIR, `${f}.md`), "utf-8");
      expect(md).toContain("UI 自动化");
      expect(() => renderRole(parseRole(md).body, { manager: "bun m.ts" })).not.toThrow();
    }
  });
});

describe("parseRole / renderRole", () => {
  test("缺 frontmatter、缺 name 报错；未知占位符报错", () => {
    expect(() => parseRole("正文")).toThrow("frontmatter");
    expect(() => parseRole("---\nname: x\n---\n正文")).toThrow("description");
    expect(renderRole("跑 {{manager}} ledger", { manager: "bun /r/m.ts" })).toBe("跑 bun /r/m.ts ledger");
    expect(() => renderRole("{{nope}}", { manager: "m" })).toThrow("{{nope}}");
  });
});

describe("materializeRole", () => {
  const src = () => ({ rolesDir: ROLES_DIR, outDir: mkdtempSync(join(tmpdir(), "roles-out-")), vars: { manager: "bun /repo/src/manager.ts" } });

  test("dispatcher：--agents 带调度助理 + 两种审查员，--agent 选调度助理；占位符已填", () => {
    const s = src();
    const r = materializeRole("dispatcher", s);
    expect(r).toEqual({ agentsFile: join(s.outDir, "dispatcher-agents.json"), agent: "claudestra-dispatcher" });
    const json = JSON.parse(readFileSync(r.agentsFile as string, "utf-8")) as Record<string, { description: string; prompt: string }>;
    expect(Object.keys(json).sort()).toEqual(["claudestra-adversarial-reviewer", "claudestra-dispatcher", "claudestra-reviewer"]);
    expect(json["claudestra-dispatcher"].prompt).toContain("bun /repo/src/manager.ts ledger dispatch");
    expect(JSON.stringify(json)).not.toContain("{{");
  });

  test("pm：审查员 --agents + 追加系统提示文件；executor：只追加系统提示", () => {
    const s = src();
    const pm = materializeRole("pm", s);
    expect(pm).toEqual({ agentsFile: join(s.outDir, "reviewer-agents.json"), promptFile: join(s.outDir, "pm.md") });
    expect(readFileSync(pm.promptFile as string, "utf-8")).toContain("编排班子的 **PM**");
    const ex = materializeRole("executor", s);
    expect(ex).toEqual({ promptFile: join(s.outDir, "executor.md") });
    expect(readFileSync(ex.promptFile as string, "utf-8")).toContain("bun /repo/src/manager.ts ledger deliver");
  });

  test("roleLaunch：没有 / 不认识的角色不加参数", () => {
    expect(roleLaunch(undefined)).toBeUndefined();
    expect(roleLaunch("boss")).toBeUndefined();
  });

  test("buildClaudeCommand：--agents 由 shell 展开文件内容（交互模式只收内联 JSON），其余路径转义", () => {
    const role = { agentsFile: "/s/roles/a b.json", agent: "claudestra-dispatcher", promptFile: "/s/p.md" };
    const cmd = buildClaudeCommand({ channelId: "c1", bridgeUrl: "ws://localhost:3847", role });
    expect(cmd).toContain(`--agents "$(cat '/s/roles/a b.json')" --agent claudestra-dispatcher --append-system-prompt-file /s/p.md`);
    expect(buildClaudeCommand({ channelId: "c1", bridgeUrl: "ws://localhost:3847" })).not.toContain("--agent");
  });

  test("真 shell 里展开：带引号 / 美元符的 JSON 原样变成一个参数", async () => {
    const s = src();
    const r = materializeRole("dispatcher", s);
    const cmd = `printf %s "$(cat ${JSON.stringify(r.agentsFile)})"`;
    const out = Bun.spawnSync(["/bin/sh", "-c", cmd]).stdout.toString();
    expect(JSON.parse(out)["claudestra-dispatcher"].prompt).toContain("ledger dispatch");
  });
});

describe("registry 的 role 字段（manager/team.ts）", () => {
  test("--role 校验、none 清除、resume 保留", () => {
    expect(resolveTeamFields({}, "agent-x", { role: "dispatcher" }, {})).toEqual({ role: "dispatcher" });
    expect(resolveTeamFields({}, "agent-x", { role: "none" }, {})).toEqual({});
    expect(resolveTeamFields({}, "agent-x", { role: "boss" }, {})).toEqual({ error: "--role 只能是 pm / dispatcher / executor / none" });
    expect(keepOnResume({ role: "pm" } as never, "s1")).toEqual({ role: "pm" });
  });
});
