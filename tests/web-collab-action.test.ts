/**
 * 协作视图「此刻动作」与「对它说」闸门（web/features/collab/collab-action.ts）。
 * detail 一律用 bridge 真实的 formatToolDetail（Pi 先过 mapPiToolCall）生成，测的是线上真会出现的字符串。
 */
import { describe, expect, test } from "bun:test";
import { formatToolDetail } from "../src/bridge/jsonl-watcher";
import { mapPiToolCall } from "../src/lib/pi-session";
import { actionLine, isWorking, liveIdle, reduceAction, sayGate, shortDetail, type ActionMap } from "../web/features/collab/collab-action";

const line = (name: string, input: unknown) => shortDetail(name, formatToolDetail(name, input));
const SECRETS = ["sk-ant", "sk_live", "ghp_", "ghs_", "glpat", "AIza", "eyJ", "SECRET", "hunter2", "p4ss", "abc123", "abcd1234", "/Users", "shawn", "~/", "My Docs", "C:\\", "secrets/"];
const leaks = (out: string) => SECRETS.filter((x) => out.includes(x));

describe("shortDetail 不泄露（审查 #144 P1-2、第 2 轮 P2-1 / P2-2）", () => {
  const cases: [string, unknown, string][] = [
    // Bash 有 description：按词清洗
    ["Bash", { description: "Read /Users/shawn/.ssh/id_rsa", command: "cat ~/.ssh/id_rsa" }, "Read"],
    ["Bash", { description: "Open /Users/shawn/My Docs/plan.md", command: "x" }, "Open plan.md"],
    ["Bash", { description: "Edit src/secrets/prod.env", command: "x" }, "Edit prod.env"],
    ["Bash", { description: "POST https://hooks.slack.com/services/T0/B0/XXSECRETXX", command: "x" }, "POST hooks.slack.com"],
    ["Bash", { description: "GET https://api.x.com/v1/u?access_token=abcd1234", command: "x" }, "GET api.x.com"],
    ["Bash", { description: "Use ghs_abcdefghijklmnop to auth", command: "x" }, "Use ••• to auth"],
    ["Bash", { description: "Call with AIzaSyA1234567890abcdefgh", command: "x" }, "Call with •••"],
    ["Bash", { description: "Auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig", command: "x" }, "Auth •••"],
    ["Bash", { description: "Set token=abc123secret", command: "x" }, "Set token=•••"],
    ["Bash", { description: "API_KEY: sk_live_abcdef123456", command: "x" }, "API_KEY: •••"],
    ["Bash", { description: "MYSQL_PWD=hunter2 mysql", command: "x" }, "MYSQL_PWD=••• mysql"],
    ["Bash", { description: "Connect DATABASE_URL=postgres://u:p4ss@h/db", command: "x" }, "Connect DATABASE_URL=•••"],
    ["Bash", { description: "curl with Bearer abcdef123456", command: "x" }, "curl with Bearer •••"],
    ["Bash", { description: "Read C:\\Users\\shawn\\secret.txt", command: "x" }, "Read secret.txt"],
    // 没有 description（Pi / Codex 的 bash 都走这里）：只报程序名
    ["Bash", { command: 'AUTH="Bearer sk-ant-api03-SECRET999" curl -H "Authorization: $AUTH" https://x' }, "curl"],
    ["Bash", { command: "API_KEY='abc def-SECRET' ./run" }, "run"],
    ["Bash", { command: 'PASS="ab;SECRETxyz" mysql' }, "mysql"],
    ["Bash", { command: "TOKEN=$(cat /Users/shawn/.tok) gh api" }, "gh"],
    ["Bash", { command: '"/Users/shawn/My Docs/run.sh" --x' }, "run.sh"],
    ["Bash", { command: "export GH_TOKEN=ghp_abcdefghijk && gh pr list" }, "gh"],
    ["Bash", { command: "(cd /Users/shawn/x && make)" }, "make"],
    ["Bash", { command: "  cd '/Users/shawn/a b' ; ls" }, "ls"],
    ["Bash", { command: "/opt/homebrew/bin/git status" }, "git"],
    // Read / Edit / Write：只留文件名；没有路径就不显示（不能露出「───」或正文）
    ["Read", { file_path: "/Users/shawn/My Docs/secret plan.md" }, "secret plan.md"],
    ["Read", { file_path: "src/secrets/prod.env" }, "prod.env"],
    ["Edit", { old_string: "TOKEN=abc", new_string: "x" }, ""],
    ["Write", { content: "SECRET=1" }, ""],
    // 白名单外的工具不带 detail
    ["Grep", { pattern: "foo", path: "/Users/shawn/repos" }, ""],
    ["mcp__mem0__memory_search", { query: "x" }, ""],
  ];
  for (const [name, input, want] of cases) {
    test(`${name} ${JSON.stringify(input).slice(0, 60)}`, () => {
      const out = line(name, input);
      expect(out).toBe(want);
      expect(leaks(out)).toEqual([]);
    });
  }

  // 审查 #144 第 3 轮 P2-1：密钥前后贴着别的字符（反引号、括号、JSON、中文）时按词切不出来，靠不锚定的前缀兜底
  const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const glued: [string, string][] = [
    [`Auth with \`${GHP}\``, "Auth with `•••`"],
    [`Auth with <${GHP}>`, "Auth with <•••>"],
    [`Auth with [${GHP}]`, "Auth with [•••]"],
    [`Use token:${GHP}`, "Use token:•••"],
    [`Post {"token":"${GHP}"}`, 'Post {"token":"•••"}'],
    [`设置GH_TOKEN=${GHP}后重试`, "设置GH_TOKEN=•••后重试"],
    [`令牌=${GHP}`, "令牌=•••"],
    [`token是${GHP}`, "token是•••"],
    [`密钥：${GHP}`, "密钥：•••"],
    [`用新密钥（${GHP}）登录`, "用新密钥（•••）登录"],
  ];
  for (const [desc, want] of glued) {
    test(`贴着别的字符的密钥：${desc.slice(0, 16)}`, () => {
      const out = line("Bash", { description: desc, command: "x" });
      expect(out).toBe(want);
      expect(out).not.toContain("ghp_");
    });
  }

  test("引号不配平、转义引号 / 空格、$'…'：programOf 宁可不显示（第 3 轮 P2-2）", () => {
    for (const command of ['echo \\"x\\" ; curl', 'FOO="unbalanced curl', "a\\ b", "X=$'sec' ls", "API='x' \"half"]) {
      expect(line("Bash", { command })).toBe("");
    }
    expect(line("Bash", { command: "ls -la" })).toBe("ls");
  });

  test("Pi 的真实路径：小写 bash / read 先经 mapPiToolCall 变成 Bash / Read", () => {
    const pi = (n: string, args: unknown) => {
      const m = mapPiToolCall(n, args);
      return line(m.name, m.input);
    };
    expect(pi("bash", { command: 'AUTH="Bearer sk-ant-api03-PISECRET" curl x' })).toBe("curl");
    expect(pi("read", { path: "/Users/shawn/.ssh/id_rsa" })).toBe("id_rsa");
    expect(pi("bash", { command: "ls /Users/shawn" })).toBe("ls");
  });

  test("description 过长按码点截 40 字，不截半个 emoji", () => {
    expect(line("Bash", { description: "跑".repeat(45), command: "ls" })).toBe(`${"跑".repeat(40)}…`);
    expect([...line("Bash", { description: "🚀".repeat(41), command: "ls" })].length).toBe(41);
  });
});

describe("动作表", () => {
  test("tool_start 记工具与短 detail；tool_done 回思考中；回合结束为空闲；无关事件返回同一张表", () => {
    let m: ActionMap = new Map();
    m = reduceAction(m, { agent: "agent-task-t5", type: "tool_start", data: { name: "Edit", detail: formatToolDetail("Edit", { file_path: "/x/scroll-anchor.ts" }) } }, 1);
    expect(m.get("task-t5")).toEqual({ kind: "tool", tool: "Edit", detail: "scroll-anchor.ts", ts: 1 });
    m = reduceAction(m, { agent: "task-t5", type: "tool_done", data: {} }, 2);
    expect(m.get("task-t5")!.kind).toBe("thinking");
    m = reduceAction(m, { agent: "task-t5", type: "agent_status", data: { status: "done" } }, 3);
    expect(m.get("task-t5")!.kind).toBe("idle");
    expect(reduceAction(m, { agent: "task-t5", type: "assistant_text", data: {} }, 4)).toBe(m);
  });

  test("MCP 工具名只留最后一段", () => {
    const m = reduceAction(new Map(), { agent: "a", type: "tool_start", data: { name: "mcp__mem0__memory_search", detail: '{"query":"secret"}' } }, 1);
    expect(m.get("a")).toEqual({ kind: "tool", tool: "memory_search", ts: 1 });
  });

  test("actionLine：工具 > 思考 > busy（压过流里陈旧的空闲）> 等人 > 空闲", () => {
    expect(actionLine({ kind: "tool", tool: "Bash", detail: "ls", ts: 0 }, false, "等 PM 放行")).toEqual({ kind: "tool", text: "Bash · ls" });
    expect(actionLine(undefined, true, "等 PM 放行").kind).toBe("thinking");
    expect(actionLine({ kind: "idle", ts: 0 }, true, "等 PM 放行").kind).toBe("thinking");
    expect(actionLine({ kind: "idle", ts: 0 }, false, "等 PM 放行")).toEqual({ kind: "waiting", text: "等 PM 放行" });
    expect(actionLine(undefined, false, null)).toEqual({ kind: "idle", text: "" });
  });
});

describe("「对它说」闸门（审查 #144 P0、第 2 轮 P1）", () => {
  test("sayGate：在干活不许发，空闲且有字才能发", () => {
    expect(sayGate(true, "先别动", false)).toEqual({ canSend: false, blockedByWork: true });
    expect(sayGate(false, "先别动", false)).toEqual({ canSend: true, blockedByWork: false });
    expect(sayGate(false, "   ", false).canSend).toBe(false);
    expect(sayGate(false, "先别动", true).canSend).toBe(false);
  });

  test("场景 A：视图开着时它空闲，页面隐藏期间开始跑长工具；回前台流里只剩旧的 idle、/agents 已报 busy → 拦住", () => {
    const m = reduceAction(new Map(), { agent: "task-x", type: "agent_status", data: { status: "done" } }, 1);
    expect(isWorking(m.get("task-x"), true)).toBe(true);
    expect(sayGate(isWorking(m.get("task-x"), true), "先别动", false).canSend).toBe(false);
  });

  test("场景 B：隐藏前在跑工具、隐藏期间结束；重连时动作表清空（use-collab onOpen），/agents busy=false → 放行", () => {
    const stale = reduceAction(new Map(), { agent: "task-y", type: "tool_start", data: { name: "Bash", detail: "bun test" } }, 1);
    expect(isWorking(stale.get("task-y"), false)).toBe(true); // 清空前宁可拦
    const afterReconnect: ActionMap = new Map();
    expect(isWorking(afterReconnect.get("task-y"), false)).toBe(false);
  });

  test("场景 C：首次打开流里还没有它、/agents 轮询滞后说空闲 → 页面放行，但点发送前实时查到在回合里就不发", () => {
    expect(isWorking(undefined, false)).toBe(false);
    expect(liveIdle({ thinking: true })).toBe(false);
    expect(liveIdle({ compacting: true })).toBe(false);
    expect(liveIdle(null)).toBe(false); // 查不到按忙处理
    expect(liveIdle({ thinking: false })).toBe(true);
    expect(liveIdle({})).toBe(true);
  });
});
