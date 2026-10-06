import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDisallowedRules, splitClaudeDisallowedRules, validateDisallowedRules } from "../src/lib/disallowed-rules";
import { buildClaudeCommand, DEFAULT_DISALLOWED, resolveDisallowed } from "../src/lib/claude-launch";
import { parseCreateArgs } from "../src/manager/create-args";
import { testChildEnv } from "./test-env";

const rules = ["Bash(git push --force:*)", "Bash(git reset --hard:*)", "Bash(:(){:|:&};:)"];
const base = { channelId: "123", bridgeUrl: "ws://127.0.0.1:9" };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perm1-"));
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ agents: { "agent-demo": { status: "active" } } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 每次调用在独立进程加载路径常量，父测试进程的环境与模块缓存完全不变。
async function permissions(...args: string[]) {
  const modulePath = resolve("src/manager/permissions.ts");
  const script = `import {cmdPermissions} from ${JSON.stringify(modulePath)}; await cmdPermissions(...${JSON.stringify(args)});`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: dir, env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

async function commandRules(command: string): Promise<string[]> {
  const child = Bun.spawn(["/bin/sh", "-c", `set -- ${command}; while [ "$#" -gt 0 ]; do if [ "$1" = --disallowedTools ]; then shift; printf '%s' "$1"; exit; fi; shift; done`], {
    cwd: dir, env: testChildEnv(), stdout: "pipe", stderr: "pipe",
  });
  const value = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return splitClaudeDisallowedRules(value);
}

test("验收1：带空格三规则 set/get/list 与启动参数保持完整", async () => {
  const raw = rules.join(" ");
  expect(parseDisallowedRules(raw)).toEqual(rules);
  const set = await permissions("set", "demo", "--disallowed", raw);
  const get = await permissions("get", "demo");
  for (const result of [set, get]) {
    expect(result.tools).toEqual(rules);
    expect(result.toolCount).toBe(3);
    expect(result.disallowedRaw).toBe(raw);
  }
  expect((await permissions("list")).agents[0]).toMatchObject({ tools: rules, toolCount: 3 });
  expect(await commandRules(buildClaudeCommand({ ...base, disallowedRaw: raw }))).toEqual(rules);
}, 30000);

test("验收2：默认预设移除三条 rm 后其余完整且启动参数无 rm", async () => {
  const remaining = DEFAULT_DISALLOWED.filter(rule => !rule.startsWith("Bash(rm"));
  expect(DEFAULT_DISALLOWED.length - remaining.length).toBe(3);
  const raw = remaining.join(" ");
  expect(resolveDisallowed({ raw })).toEqual(remaining);
  expect(await commandRules(buildClaudeCommand({ ...base, disallowedRaw: raw }))).toEqual(remaining);
}, 30000);

test("验收3：括号外分隔、嵌套括号与内部逗号保留且 raw 原样保存", async () => {
  const raw = "  Read,\n Bash(echo a,b (nested x,y):*)  Edit\t ";
  const expected = ["Read", "Bash(echo a,b (nested x,y):*)", "Edit"];
  expect(parseDisallowedRules(raw)).toEqual(expected);
  expect(validateDisallowedRules(raw)).toBeUndefined();
  expect(parseCreateArgs(["demo", "/repo", "--disallowed", raw])).toMatchObject({ perms: { disallowedRaw: raw } });
  expect((await permissions("set", "demo", "--disallowed", raw)).tools).toEqual(expected);
  expect((await permissions("get", "demo")).disallowedRaw).toBe(raw);
  expect(await commandRules(buildClaudeCommand({ ...base, disallowedRaw: raw }))).toEqual(expected);
}, 30000);

test("验收3：空清单、括号不配对、非法格式在 set/create 拒绝且 registry 不变", async () => {
  const original = readFileSync(join(dir, "registry.json"), "utf8");
  for (const raw of ["", " , \t", "Bash(foo", "Read Bash(foo))", "Read !bad", "Bash(a)(b)", "Bash(x)tail"]) {
    const set = await permissions("set", "demo", "--disallowed", raw);
    expect(set.ok).toBe(false);
    expect(set.error).toContain("条规则");
    const create = parseCreateArgs(["demo", "/repo", "--disallowed", raw]);
    expect(create).toHaveProperty("error");
    expect((create as { error: string }).error).toContain("条规则");
    expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(original);
  }
  expect((await permissions("set", "demo", "--disallowed")).error).toContain("条规则");
  expect(parseCreateArgs(["demo", "/repo", "--disallowed"])).toHaveProperty("error");
  expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(original);
}, 30000);

test("验收4：default/strict 预设命令逐字保持原有规则编码", () => {
  const originalDefault = [
    "Bash(rm -rf:*)", "Bash(rm -r:*)", "Bash(rmdir:*)", "Bash(git push --force:*)",
    "Bash(git reset --hard:*)", "Bash(git clean -f:*)", "Bash(chmod 777:*)", "Bash(:(){:|:&};:)",
  ];
  const originalStrict = [...originalDefault, ...["sudo", "su", "curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "dd", "mkfs"].map(tool => `Bash(${tool}:*)`)];
  for (const [preset, original] of [["default", originalDefault], ["strict", originalStrict]] as const) {
    expect(resolveDisallowed({ preset })).toEqual(original);
    expect(buildClaudeCommand({ ...base, disallowedPreset: preset })).toBe(buildClaudeCommand({ ...base, disallowedTools: original }));
  }
}, 30000);


test("r1 P1-1：Claude Code 会拆开的嵌套规则在 set/create 拒绝且 registry 不变", async () => {
  const original = readFileSync(join(dir, "registry.json"), "utf8");
  const cases = [
    ["Bash(:(){ :|:&};:)", ["Bash(:(){", ":|:&};:)"]],
    ["Bash(foo (x) bar:*)", ["Bash(foo (x)", "bar:*)"]],
    ["Bash(f (x),y:*)", ["Bash(f (x)", "y:*)"]],
    ["Bash(python -c print(1) foo:*)", ["Bash(python -c print(1)", "foo:*)"]],
  ] as const;
  for (const [rule, fragments] of cases) {
    const raw = `Read ${rule}`;
    expect(parseDisallowedRules(raw)).toEqual(["Read", rule]);
    expect(splitClaudeDisallowedRules(raw)).toEqual(["Read", ...fragments]);
    const error = validateDisallowedRules(raw);
    if (!error) throw new Error(`应拒绝规则 ${raw}`);
    expect(error).toContain("第 2 条规则");
    expect(error).toContain(`Claude Code 会把它拆成 ${JSON.stringify(fragments)}`);
    expect(await permissions("set", "demo", "--disallowed", raw)).toMatchObject({ ok: false, error });
    expect(parseCreateArgs(["demo", "/repo", "--disallowed", raw])).toEqual({ error });
    expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(original);
  }
}, 30000);

test("r1 P2-b：MCP 通配名与转义括号仍接受并保持完整", async () => {
  const expected = ["mcp__*", "mcp__x__*", String.raw`Bash(echo \( x:*)`, String.raw`Bash(echo \):*)`, String.raw`Bash(echo \\:*)`];
  const raw = expected.join(" ");
  expect(parseDisallowedRules(raw)).toEqual(expected);
  expect(splitClaudeDisallowedRules(raw)).toEqual(expected);
  expect(validateDisallowedRules(raw)).toBeUndefined();
  expect(parseCreateArgs(["demo", "/repo", "--disallowed", raw])).toMatchObject({ perms: { disallowedRaw: raw } });
  expect(await permissions("set", "demo", "--disallowed", raw)).toMatchObject({ ok: true, tools: expected });
  expect(await permissions("get", "demo")).toMatchObject({ disallowedRaw: raw, tools: expected });
  expect(await commandRules(buildClaudeCommand({ ...base, disallowedRaw: raw }))).toEqual(expected);
}, 30000);

test("r1 P2-a：实际切分器保留 tab 且按首个右括号回到括号外", () => {
  expect(splitClaudeDisallowedRules(" Read, Edit  ")).toEqual(["Read", "Edit"]);
  expect(splitClaudeDisallowedRules("Read\tEdit")).toEqual(["Read\tEdit"]);
  expect(splitClaudeDisallowedRules("Bash(a (b) c) ")).toEqual(["Bash(a (b)", "c)"]);
});
