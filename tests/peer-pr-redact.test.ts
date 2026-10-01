/** i28-A2 §5 外发前的脱敏与门：本机身份、临时路径、项目目录名、非 commit 长十六进制；门只认脱敏后的文本。推送正文的渲染。 */
import { describe, expect, test } from "bun:test";
import { conclusionOf, nextStepOf, renderReviewPush } from "../src/lib/peer-pr-message.ts";
import { HEX_MASK, hexCandidates, peerPrSecretHit, redactPeerPr, TEMP_DIR } from "../src/lib/peer-pr-redact.ts";

const ID = { username: "alice", hostname: "alice-mbp.local" };
const HEAD = "ab".repeat(20);
const OTHER = "cd".repeat(20);

describe("redactPeerPr", () => {
  test("本机用户名、主机名（带不带 .local）、临时路径、Claude 项目目录名", () => {
    const r = redactPeerPr("alice 在 alice-mbp 跑过 /private/tmp/claude-501/x.log 与 /var/folders/ab/T/y，目录 -Users-alice-repos-x", ID, new Set());
    expect(r.text).not.toContain("alice");
    expect(r.text).toContain(TEMP_DIR);
    expect(r.text).toContain("-Users-[已脱敏:个人信息]-repos-x");
    expect(r.count).toBeGreaterThanOrEqual(5);
  });

  test("只保留仓库认得的 commit，别的长十六进制一律遮", () => {
    const r = redactPeerPr(`head ${HEAD}，另一个 ${OTHER}，短 sha ${HEAD.slice(0, 12)}`, ID, new Set([HEAD]));
    expect(r.text).toContain(HEAD);
    expect(r.text).not.toContain(OTHER);
    expect(r.text).toContain(HEX_MASK);
    expect(r.text).toContain(HEAD.slice(0, 12));
  });

  test("同输入同输出；短名字不当规则（误伤太多）", () => {
    const text = `x ${OTHER} alice`;
    expect(redactPeerPr(text, ID, new Set())).toEqual(redactPeerPr(text, ID, new Set()));
    expect(redactPeerPr("ab cd", { username: "ab", hostname: "cd" }, new Set()).text).toBe("ab cd");
  });

  test("hexCandidates 只取 40 / 64 位", () => {
    expect(hexCandidates(`${HEAD} ${"e".repeat(64)} ${"f".repeat(50)}`)).toEqual([HEAD, "e".repeat(64)]);
  });
});

describe("peerPrSecretHit", () => {
  const prefix = "gh" + "p_" + "A1b2".repeat(6);
  test("脱敏后的报告放行，占位符本身不算", () => {
    const r = redactPeerPr(`token 在 ${prefix}，commit ${HEAD}`, ID, new Set([HEAD]));
    expect(peerPrSecretHit(r.text, new Set([HEAD]))).toBeNull();
  });

  test("拆空格的密钥前缀、Bearer、长十六进制、随机串都拦", () => {
    expect(peerPrSecretHit(prefix.slice(0, 8) + " " + prefix.slice(8), new Set())).toBe("密钥前缀");
    expect(peerPrSecretHit("Authorization: Bearer abc123def456", new Set())).not.toBeNull();
    expect(peerPrSecretHit(`见 ${OTHER}`, new Set())).toBe("长十六进制");
    expect(peerPrSecretHit(`见 ${OTHER}`, new Set([OTHER]))).toBeNull();
    expect(peerPrSecretHit("Zx9" + "Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVc", new Set())).toBe("随机串");
  });

  test("单词里的 sk- / tok_ 不算（task-…、stock_…）", () => {
    expect(peerPrSecretHit("task-scheduler-pass-tick-review-merge stock_quantity_lookup", new Set())).toBeNull();
    expect(peerPrSecretHit("sk-" + "a1".repeat(10), new Set())).toBe("密钥前缀");
  });

  test("前缀自己被拆开（每个位置插空白 / 零宽 / 组合符 / 填充符）也拦；单词中间仍不算", () => {
    const blanks = [" ", "  ", "\n", "\t", "\u3000", "\u200b", "\u2060", "\ufeff", "\u034f", "\u3164", "\u2800", " \u200b "];
    for (const [key, value] of [["sk-", "abcdefghijklmnopqrstuvwx"], ["tok_", "abcdefgh12"]] as const) {
      const raw = key + value;
      for (let i = 1; i <= key.length; i++) {
        for (const b of blanks) {
          const split = `报告：${raw.slice(0, i)}${b}${raw.slice(i)} 完`;
          expect([split, peerPrSecretHit(split, new Set())]).toEqual([split, "密钥前缀"]);
          const out = redactPeerPr(split, ID, new Set()).text; // after masking: either the value is gone or the gate still refuses
          expect([split, out.includes(value) ? peerPrSecretHit(out, new Set()) : "已遮"]).not.toEqual([split, null]);
        }
      }
    }
    expect(peerPrSecretHit("s k - a b c d e f g h i j k l m n o p q r s t u v w x", new Set())).toBe("密钥前缀");
    expect(peerPrSecretHit("ta s k - scheduler", new Set())).toBeNull(); // too short to be a key
    expect(peerPrSecretHit("task-scheduler-pass-tick-review-merge", new Set())).toBeNull();
  });

  test("敏感字段名", () => {
    expect(peerPrSecretHit('{"password": "hunter2hunter2"}', new Set())).toBe("敏感字段名");
  });
});

describe("推送正文", () => {
  const counts = { verdict: "changes", p0: 0, p1: 2, p2: 1, round: 1 };
  test("首行结论、head12、报告编号、下一步、回复地址", () => {
    const text = renderReviewPush({ number: 401, taskId: "PR401", head: HEAD, counts, maxRounds: 2, replyTo: "agent-x@me", report: "原文", masked: 3 });
    expect(text.split("\n")[0]).toBe("[Claudestra 调度器 · PR #401 第 1 轮审查] 不通过（2 个 P1）");
    expect(text).toContain(`head：${HEAD.slice(0, 12)}`);
    expect(text).toContain("报告编号：PR401-r1");
    expect(text).toContain("有异议或问题回：agent-x@me");
    expect(text).toContain("已脱敏 3 处");
  });

  test("结论与下一步矩阵", () => {
    expect(conclusionOf({ ...counts, p1: 0 })).toBe("通过，留 1 个 P2");
    expect(conclusionOf({ ...counts, p0: 1 })).toBe("阻塞（P0）");
    expect(nextStepOf(counts, 2)).toContain("直接 push");
    expect(nextStepOf({ ...counts, round: 2 }, 2)).toContain("已转 PM");
    expect(nextStepOf({ ...counts, p1: 0 }, 2)).toContain("合并队列");
  });
});
