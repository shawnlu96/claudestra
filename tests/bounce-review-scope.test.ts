/**
 * BOUNCESCOPE1：合并队列退回后的定向复验范围按推送内容定——合并提交只核解冲突 / 合入 main 的部分，
 * 同一推送里合并之外的作者提交全部复验；给作者的说明不再邀请回复。
 */
import { describe, expect, test } from "bun:test";
import { renderBouncePush } from "../src/lib/peer-pr-message.js";
import { bounceReviewLine, type MergeBounce } from "../src/lib/scheduler-merge-conflict.js";

const H = "a".repeat(40);
const bounces: MergeBounce[] = [
  { cause: "conflict", prHead: H, mainHead: "b".repeat(40), checks: [] },
  { cause: "update_fail", prHead: H, mainHead: null, checks: [], error: "HTTP 422" },
  { cause: "ci_fail", prHead: H, mainHead: null, checks: [{ name: "check", link: "https://x/run/1" }] },
];

describe("[验收线 1] bounceReviewLine：复验范围是原 head..新 head 的全部作者改动", () => {
  for (const b of bounces) {
    test(b.cause, () => {
      const line = bounceReviewLine(b);
      expect(line.startsWith("定向复验")).toBe(true);
      expect(line).toContain(`原 head ${H.slice(0, 12)}`);
      expect(line).toContain("合并之外的作者提交全部复验");
      expect(line).toContain(`git log --no-merges --first-parent ${H.slice(0, 12)}..`);
      expect(line).toContain("不沿用旧审查");
      expect(line).not.toContain("只看");
    });
  }
  test("纯合 main 的推送：合并提交仍只核解冲突 / 合入 main 的部分，范围没收窄", () => {
    expect(bounceReviewLine(bounces[0]!)).toContain("合并提交只核解冲突的部分");
    expect(bounceReviewLine(bounces[1]!)).toContain("合并提交只核合入 main 的部分");
  });
});

describe("[验收线 2] renderBouncePush：不再邀请回复", () => {
  for (const b of bounces) {
    test(b.cause, () => {
      const lines = renderBouncePush(9, b, "agent-x@peer").split("\n");
      const text = lines.join("\n");
      expect(text).not.toContain("只看");
      expect(text).toContain("推到本 PR 分支即可。顺带的代码改动会一并复验，不用另外告知，也不用回复。");
      expect(lines.at(-1)).toBe("卡住了再回：agent-x@peer");
      expect(text).not.toContain("有问题回");
    });
  }
});
