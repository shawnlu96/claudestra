import { describe, expect, test } from "bun:test";
import { createTranscriptStamper, transcriptOfEntry } from "../src/lib/acp/transcript.ts";
import { summarizeCommand } from "../src/lib/tool-display-format.ts";
import { renderFixtures } from "./helpers/acp-transcript-fixtures.ts";

// ACP 窗口可读性：成功输出只报行数、命令一行人话、正文 / 回复 / 收到的消息分段，时间戳只在段落起点和分钟变化时出现
const EXPECTED = `[11:23:20] 👤 owner：审一下 LCK-1 的放锁改动

[11:23:21] 🤖 先看改动前后的放锁代码。
           💻 读 src/lib/ledger-scheduler-lease-finished.ts（93410059） ＋1 条
             ↳ 339 行输出
           💻 git diff 93410059 HEAD -- src/lib/ledger-scheduler-lease-sync.ts
             ↳ 226 行输出
[11:24:05] 💻 mktemp -d /private/tmp/lck1-audit.XXXXXX
             ↳ /private/tmp/lck1-audit.RNofCB
           💻 搜 'CREATE TABLE IF NOT EXISTS scheduler_resources|CREATE TABLE scheduler_resources' 于 src/lib/ledger-*.ts ＋1 条
             ↳ 38 行输出
           💻 mkdir -p /tmp/a/home /tmp/a/tmp（6 行脚本）
             ↳ 14 行输出
[11:25:27] 💻 git status --short ＋2 条
             ↳ 无输出
           💻 bun test tests/scheduler-merge-handoff.test.ts
             ✗ （共 30 行，末尾 4 行）
               (pass) case 26
               (pass) case 27
               error: expect(received).toBe(expected)
               (fail) lease > releases lock

[11:25:28] 🤖 放锁条件少了完整 diff 参数，结论如下。

[11:25:28] 💬 回复：P1=1：文件 diff 缺 --no-relative
             ↳ Sent message(s): ["1557232365116456974"]
           ── 回合结束 ──`;

const run = (command: string, out: string, isError = false) => transcriptOfEntry({ type: "assistant", message: { content: [
  { type: "tool_use", id: "c", name: "Bash", input: { command } },
  { type: "tool_result", tool_use_id: "c", content: out, ...(isError ? { is_error: true } : {}) },
] } });

describe("ACP 窗口可读性", () => {
  test("审计窗口的典型条目：整屏对照", () => {
    const view = renderFixtures();
    expect(view).toBe(EXPECTED);
    expect(view).not.toMatch(/const x\d/); // 成功输出里的代码行一行都不进窗口
  });

  test("成功输出：1–2 行原样显示，多了只报行数，空的说无输出；失败不足 4 行就全显示", () => {
    expect(run("pwd", "/a\n/b\n")[1]).toBe("  ↳ /a\n    /b");
    expect(run("ls", "a\nb\nc")[1]).toBe("  ↳ 3 行输出");
    expect(run("true", "  \n")[1]).toBe("  ↳ 无输出");
    expect(run("false", "boom", true)[1]).toBe("  ✗ boom");
    expect(run("false", "", true)[1]).toBe("  ✗ 无输出");
  });

  test("命令摘要：剥 cd / env 前缀、shell 包装，读取类和搜索类写成人话，认不出退回原命令", () => {
    expect(summarizeCommand("/bin/zsh -lc 'cd /repo && sed -n '\\''10,20p'\\'' src/a.ts'")).toBe("读 src/a.ts:10-20");
    expect(summarizeCommand("cd /repo && NODE_ENV=test FOO='a b' bun test x.test.ts")).toBe("bun test x.test.ts");
    expect(summarizeCommand("cd /repo")).toBe("cd /repo");
    expect(summarizeCommand("cat a.ts b.ts | grep foo")).toBe("读 a.ts b.ts | …");
    expect(summarizeCommand("nl -ba src/x.ts | head -n 40")).toBe("读 src/x.ts");
    expect(summarizeCommand("tail -n 85 log.txt")).toBe("读 log.txt");
    expect(summarizeCommand("git show HEAD~1 --stat")).toBe("看提交 HEAD~1");
    expect(summarizeCommand("rg -n -g '*.ts' -e 'a;b' src")).toBe("搜 'a;b' 于 src");
    expect(summarizeCommand("grep -rn 'x && y' .; echo done")).toBe("搜 'x && y' 于 . ＋1 条");
    expect(summarizeCommand("echo \"$(date; whoami)\" | tee out")).toBe("echo \"$(date; whoami)\" | …");
    expect(summarizeCommand("python3 - <<'PY'\nprint(1)\nPY")).toBe("python3 - <<'PY'（3 行脚本）");
    expect(summarizeCommand("cat")).toBe("cat");
    expect(summarizeCommand("rg --files src/lib")).toBe("列文件 src/lib");
    expect(summarizeCommand("rg --files -g '*.ts' src")).toBe("列文件 src");
    expect(summarizeCommand("rg --files")).toBe("列文件 .");
  });

  test("时间戳：段落起点必带、前面空一行；同一分钟的工具行不带，分钟变了再带", () => {
    const stamp = createTranscriptStamper();
    const t = (m: number, s: number) => new Date(2026, 9, 7, 9, m, s);
    expect(stamp("💻 ls", t(1, 0))).toBe("[09:01:00] 💻 ls");
    expect(stamp("  ↳ 3 行输出", t(1, 5))).toBe(`${" ".repeat(11)}  ↳ 3 行输出`);
    expect(stamp("🤖 好", t(1, 9))).toBe("\n[09:01:09] 🤖 好");
    expect(stamp("💻 pwd\n  ↳ x", t(2, 0))).toBe(`[09:02:00] 💻 pwd\n${" ".repeat(11)}  ↳ x`);
    expect(createTranscriptStamper()("👤 a：b", t(3, 0))).toBe("[09:03:00] 👤 a：b"); // 窗口第一行不空行
  });

  test("脱敏在摘要和截断之前：命令里的 JWT / token、失败输出末尾里的密钥都打码，截断处不留前缀", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    const cmd = `cd /r && curl -H "Authorization: Bearer ${jwt}" https://x/api?token=${jwt}`;
    const [line, result] = run(cmd, `${"ok\n".repeat(50)}denied for ${jwt}\nsk-abcdefghijklmnopqrstuvwxyz123456`, true);
    expect(line).toStartWith("💻 curl -H ");
    for (const s of [line!, result!]) {
      expect(s).not.toContain("eyJhbGci");
      expect(s).not.toContain("sk-abc");
    }
    expect(result).toContain("denied for [redacted]");
    const long = run(`${"x".repeat(190)} ${jwt}`, "")[0]!; // JWT 跨在 200 字截断处
    expect(long).not.toContain("eyJ");
    const huge = run("cat big", `${"y".repeat(20_000)}${jwt}\nend`, true)[1]!; // 超过扫描窗口：截出来的半行整行不要
    expect(huge).not.toContain("eyJ");
    expect(huge).toContain("end");
    // 命令超过扫描窗口、前缀又被摘要剥掉：窗口截在半个密钥上，那半个不能露出来
    const cut = run(`cd /${"a".repeat(15_975)} && sk-abcdefghijklmnopqrstuvwxyz123456`, "")[0]!;
    expect(cut).not.toContain("sk-abc");
  });
});
