import { describe, expect, test } from "bun:test";
import { redactForPeer } from "../src/lib/dispatch-redact.js";
import { OrderRenderError, redactOrderForPeer, renderOrderWire } from "../src/lib/order-wire-render.js";
import { orderWireOf } from "../src/lib/order-wire.js";
import { peerSecretHit } from "../src/lib/peer-secret-gate.js";

const HEAD = "527a69f8e17a58fa03fb8caa793315375ab719bd";
// PM supplied these three English findings from He's CONV1-r1 report; the last Chinese line is a synthetic addition.
// Reviewed before inclusion: no addresses, contacts or personal paths. Keep the prose intact to catch whitespace-join regressions.
const REPORT = [
  "# i28-CONV1 第 1 轮审查",
  `审查 head:\`${HEAD}\`;比较基点:\`5bf6c0fd5\`。结论:**changes**(P1 3 项,P0/P2 0 项)。`,
  "编号：dag-key-overflow　类别：followup",
  "[验收线 2] Valid original DAG keys can be too long for the required f<round> suffix. rewriteDag rejects the child; " +
    "the error is recorded as a note while review_downgrade is deduplicated, so the required follow-up node is permanently missing.",
  "编号：open-finding-rename　类别：scope",
  "[验收线 3] Prior open P1 identity is checked only by findingId, although p1FindingStreak already treats normalized family " +
    "as the fallback identity for renamed findings. A renamed unresolved finding can therefore be downgraded and merged.",
  "编号：legacy-report-heading　类别：basis",
  "[验收线 5] The legacy report parser misses a basis marker in a finding section heading when the finding ID appears only in the section body. " +
    "An old remote verdict with no basis field is wrongly downgraded despite its report marker.",
  "补充核对 src/lib/review-converge.ts:62,75：p1FindingStreak 和 convergeFindings 应沿用未解决问题的身份。",
].join("\n");

const order = (input: string, head = HEAD) => orderWireOf({
  taskId: "i28-CONV1", specRev: 1, head, round: 1, node: "fix", step: "fix", dedupKey: "lend:i28-CONV1:s1:r1:a0",
  inputs: ["规格：修复上一轮审查问题", input], outputs: ["分支提交"], acceptance: ["逐条自查"], writeBack: "调用 deliver",
  findings: [], fallbackWarning: null,
}, { repo: "shawnlu96/claudestra", pr: null, dagVersion: 1 });

const peerRefuses = (input: string) => {
  expect(() => redactOrderForPeer(order(input), HEAD)).toThrow(OrderRenderError);
  expect(() => renderOrderWire(order(input), { audience: "peer", ledgerHead: HEAD })).toThrow(OrderRenderError);
};

describe("peer secret gate: review prose", () => {
  test("PM's English review fixture reaches both peer exits as repair-order input", () => {
    expect(redactForPeer(REPORT).count).toBe(0);
    expect(peerSecretHit(REPORT)).toBe("长十六进制");
    expect(peerSecretHit(REPORT, HEAD)).toBeNull();
    const wire = order(REPORT);
    const { order: red, count } = redactOrderForPeer(wire, HEAD);
    expect(count).toBe(0);
    const rendered = renderOrderWire(wire, { audience: "peer", ledgerHead: HEAD });
    for (const line of REPORT.split("\n")) {
      const normalized = line.normalize("NFKC");
      expect(red.inputs[1]).toContain(normalized);
      expect(rendered).toContain(normalized);
    }
  });

  test("Chinese specs with filenames, card ids, camelCase and their own head pass", () => {
    const input = `本卡 head ${HEAD}；报告 ledger/reviews/i28-CONV1-r1/lend-Sekai-lend_i28-CONV1_s1_r2_a0.md。\n` +
      "检查 p1FindingStreakHandlesNormalizedFamily、priorOpenP1IdentityNormalizedByFindingId、" +
      "serializeVersion2ReportForRemoteReview；保留 snake_case_review_finding_v1，单号 lend:i28-CONV1:s1:r2:a0。";
    expect(peerSecretHit(input, HEAD)).toBeNull();
    expect(() => redactOrderForPeer(order(input), HEAD)).not.toThrow();
    expect(() => renderOrderWire(order(input), { audience: "peer", ledgerHead: HEAD })).not.toThrow();
  });

  test("ordinary words and identifier fragments never become random by whitespace deletion", () => {
    for (const input of [
      "Prior open P1 identity is checked only by findingId",
      "p1FindingStreak handles normalized family fallback",
      "reviewFindingVersion2 pendingReviewRound1 convergeFindings",
      "src/lib/review-converge.ts:62,75 lend-Sekai-lend_i28-CONV1_s1_r2_a0",
      "ledger/reviews/i28-V1p-r1/lend-Sekai-lend_i28-V1p_s1_r2_a0.md",
    ]) expect(peerSecretHit(input)).toBeNull();
  });
});

describe("peer secret gate: exact ledger head", () => {
  test("every id field still refuses the ledger head even when free text quotes it", () => {
    const base = order(`本卡 ${HEAD}`);
    for (const patch of [{ orderId: HEAD }, { taskId: HEAD }, { node: HEAD }, { repo: `owner/${HEAD}` },
      { findings: [{ findingId: HEAD, family: "scope", severity: "P1" as const, probe: "问题" }] },
      { findings: [{ findingId: "finding", family: HEAD, severity: "P1" as const, probe: "问题" }] }]) {
      expect(() => redactOrderForPeer({ ...base, ...patch }, HEAD)).toThrow(OrderRenderError);
      expect(() => renderOrderWire({ ...base, ...patch }, { audience: "peer", ledgerHead: HEAD })).toThrow(OrderRenderError);
    }
  });

  test("only exact whole 40/64-character values are exempt before whitespace folding", () => {
    for (const head of [HEAD, "a1b2c3d4".repeat(8)]) {
      for (const text of [head, `head: \`${head}\``, `本卡${head}。`, `head ${head}\nagain ${head}`]) {
        expect(peerSecretHit(text, head)).toBeNull();
        expect(() => redactOrderForPeer(order(text, head), head)).not.toThrow();
      }
      for (const text of [head.toUpperCase(), `ref_${head}`, `${head}_x`, `x${head}`, `${head}0`, `ref-${head}`,
        head.slice(0, 20) + "\t" + head.slice(20), head.slice(0, 20) + " " + head.slice(20)]) {
        expect(peerSecretHit(text, head)).toBe("长十六进制");
      }
      expect(peerSecretHit(head)).toBe("长十六进制");
      expect(peerSecretHit(head, null)).toBe("长十六进制");
      expect(peerSecretHit(`token: ${head}`, head)).toBe("敏感字段名");
      expect(peerSecretHit(`Bearer ${head}`, head)).toBe("Bearer");
    }
  });

  test("other long hex and malformed ledger heads never receive an exemption", () => {
    for (const hex of ["e".repeat(32), "d".repeat(40), "f".repeat(64), HEAD + "abcd"]) {
      expect(peerSecretHit(hex, HEAD)).toBe("长十六进制");
      peerRefuses(`本卡 ${HEAD}，另一个值 ${hex}`);
    }
    for (const head of ["a".repeat(32), "a".repeat(48), "a".repeat(65), "[a-f]{40}"]) {
      expect(peerSecretHit("a".repeat(40), head)).toBe("长十六进制");
    }
  });
});

describe("peer secret gate: real secret shapes", () => {
  // Synthetic base62 values, never real credentials.
  const random = "Q7mZ2rXa9Lk4Vp8Nc3Tj6Hw0Bs5Dy1FuE2oRgP9v";

  test("a 40-character random value refuses alone and inside a filename or identifier", () => {
    expect(random.length).toBe(40);
    for (const value of [random, `ref_${random}`, `reports/${random}.md`, `lend-${random}-s1-r2-a0`,
      "AbCdEfGh12345678AbCdEfGh12345678", "Q7mZ2rXa9L_k4Vp8Nc3Tj6_Hw0Bs5Dy1FuEoRgPiKv"]) {
      expect(peerSecretHit(value, HEAD)).toBe("随机串");
      peerRefuses(value);
    }
  });

  test("space/newline/tab splits into two or three mixed fragments still refuse", () => {
    for (const blank of [" ", "\n", "\t"]) {
      for (let first = 8; first <= random.length - 8; first++) {
        const two = random.slice(0, first) + blank + random.slice(first);
        expect(peerSecretHit(two)).toBe("随机串");
        peerRefuses(two);
        for (let second = first + 8; second <= random.length - 8; second++) {
          const three = [random.slice(0, first), random.slice(first, second), random.slice(second)].join(blank);
          expect(peerSecretHit(three)).toBe("随机串");
          peerRefuses(three);
        }
      }
    }
  });

  test("prefix, Bearer and PEM checks still see through whitespace anywhere", () => {
    const values = ["sk-" + "x".repeat(24), "ghp_" + "A1b2".repeat(8), "AKIA" + "1234567890ABCDEF",
      "xoxb-" + "1234567890AB", "tok_" + "A1b2".repeat(4), "Bearer abcdefgh12345678", "-----BEGIN RSA PRIVATE KEY-----"];
    for (const value of values) {
      for (const blank of ["", " ", "\n", "\t"]) {
        const split = [...value].join(blank);
        expect(peerSecretHit(split)).not.toBeNull();
        peerRefuses(split);
      }
    }
  });

  test("sensitive field names and rendering's Unicode normalization retain their protection", () => {
    for (const value of ['"token": "short"', "password=hunter2", "api_key:\n  short", "--api-key short", "credential: private"])
      expect(peerSecretHit(value, HEAD)).toBe("敏感字段名");
    for (const value of ["to\u200bken: short", "ｓｋ－" + "x".repeat(24), random.slice(0, 20) + "\u200b" + random.slice(20),
      random.slice(0, 20) + "\u2060" + random.slice(20)]) peerRefuses(value);
  });
});
