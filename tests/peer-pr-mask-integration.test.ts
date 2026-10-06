/** Synthetic sender pipeline and real bridge recheck; POST is captured, never sent to a peer. */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { handlePeerPrPush, type PeerPrSendDeps } from "../src/bridge/peer-pr-send.ts";
import type { PeerPrConfig } from "../src/lib/peer-pr-config.ts";
import { REDACTED } from "../src/lib/dispatch-redact.ts";
import { GATE_REJECTED, renderReviewPush } from "../src/lib/peer-pr-message.ts";
import { peerPrSecretHit, redactPeerPr } from "../src/lib/peer-pr-redact.ts";

const HEAD = "ab".repeat(20), FP = "0a1b-2c3d-4e5f-6a7b";
const COMMITS = new Set([HEAD]);
const ID = { username: "synthetic-user", hostname: "synthetic-host" };
const VALUE = "synthetic-private-value";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function render(raw: string): string {
  const red = redactPeerPr(raw, ID, COMMITS);
  return renderReviewPush({ number: 1, taskId: "PR1", head: HEAD,
    counts: { verdict: "changes", p0: 0, p1: 1, p2: 0, round: 1 }, maxRounds: 2,
    replyTo: "agent-synthetic@fixture", report: red.text, masked: red.count });
}

async function bridge(text: string) {
  const posts: string[] = [];
  const deps: PeerPrSendDeps = {
    readConfig: () => ({ kind: "on", config: { repoDir: "/synthetic-repo",
      peers: [{ peer: "fixture", fp: FP, agent: "agent-synthetic" }] } as PeerPrConfig }),
    peers: async () => [{ name: "fixture", fp: FP, baseUrl: "http://127.0.0.1:9", outToken: "synthetic", addedAt: "" }],
    commits: async (_dir, shas) => new Set(shas.filter((s) => COMMITS.has(s))),
    post: async (url, _headers, body) => {
      expect(url).toBe("http://127.0.0.1:9/api/v1/agents/agent-synthetic/messages");
      posts.push(JSON.parse(body).text);
      return 202;
    },
  };
  const result = await handlePeerPrPush({ type: "peer_pr_push", peer: "fixture", fp: FP,
    agent: "agent-synthetic", key: "PR1:review:1", text, shas: [HEAD] }, false, deps);
  return { result, posts };
}

describe("PRMASK synthetic mask → render → gate → bridge", () => {
  test("reproduction: quoted field placeholders survive both real gates without removing findings", async () => {
    const raw = `P1 finding F1: exposed credentials\n{"password": "${VALUE}", "outToken": '${VALUE}'}\nhead ${HEAD}`;
    const digest = hash(raw);
    const text = render(raw);
    expect(text).toContain('"password": "' + REDACTED.secret + '"');
    expect(text).toContain("P1 finding F1: exposed credentials");
    expect(text).not.toContain(VALUE);
    expect(peerPrSecretHit(text, COMMITS)).toBeNull();
    const sent = await bridge(text);
    expect(sent.result).toEqual({ result: { status: 202 } });
    expect(sent.posts).toEqual([text]);
    expect(sent.posts[0]).not.toContain(VALUE);
    expect(hash(raw)).toBe(digest);
  });

  test("bridge independently accepts quoted masked fields", async () => {
    const text = `P1 finding F2\n{"secret": "${REDACTED.secret}"}`;
    expect((await bridge(text)).result).toEqual({ result: { status: 202 } });
  });

  test("crossline-1 reproduction: fully masked bare continuations pass sender and bridge gates", async () => {
    const values = ["synthval-aaa", "synthval-bbb", "synthval-ccc"];
    for (const body of [`password: ${values[0]}\n ${values[1]}`,
      `password: ${values[0]}\n ${values[1]}\n\n ${values[2]}\nsecret: ${values[0]}`]) {
      const raw = `P1 finding crossline-1\n${body}\nhead ${HEAD}`;
      const digest = hash(raw);
      const masked = redactPeerPr(raw, ID, COMMITS).text;
      expect(masked).toContain(`password: ${REDACTED.secret}\n ${REDACTED.secret}`);
      expect(peerPrSecretHit(masked, COMMITS)).toBeNull();
      const text = render(raw);
      expect(text).toContain("P1 finding crossline-1");
      expect(peerPrSecretHit(text, COMMITS)).toBeNull();
      const sent = await bridge(text);
      expect(sent.result).toEqual({ result: { status: 202 } });
      expect(sent.posts).toEqual([text]);
      for (const value of values) expect(sent.posts[0]).not.toContain(value);
      expect(hash(raw)).toBe(digest);
    }
  });

  test("masked continuation rows never exempt a later raw or partial continuation", async () => {
    const mask = REDACTED.secret;
    for (const bad of [VALUE, `${mask}${VALUE}`, `${VALUE}${mask}`, `[已脱敏:伪造]`,
      `${mask}\u200b${VALUE}`, `${mask}\\n${VALUE}`, `"${mask}" + "${VALUE}"`]) {
      const text = `P1 finding crossline-negative\npassword: ${mask}\n ${mask}\n\n ${bad}`;
      expect(peerPrSecretHit(text, COMMITS)).toBe("敏感字段名");
      const sent = await bridge(text);
      expect(sent.result).toMatchObject({ rejected: GATE_REJECTED });
      expect(sent.posts).toHaveLength(0);
    }
  });

  test("JSON, single/double quotes, YAML and bare values preserve report evidence after masking", async () => {
    for (const fields of [`{"password": "${VALUE}"}`, `secret: '${VALUE}'`, `outToken="${VALUE}"`,
      `password: ${VALUE}`, `--api-key ${VALUE}`]) {
      const raw = `P1 finding F4: synthetic evidence\n${fields}\nhead ${HEAD}`;
      const digest = hash(raw);
      const text = render(raw);
      expect(text).not.toContain(VALUE);
      expect(text).toContain("P1 finding F4: synthetic evidence");
      expect(peerPrSecretHit(text, COMMITS)).toBeNull();
      expect((await bridge(text)).posts).toEqual([text]);
      expect(hash(raw)).toBe(digest);
    }
  });

  test("mixed, escaped, multiline and forged masks are refused or completely redacted through the real pipeline", async () => {
    const mask = REDACTED.secret;
    const bodies = [`password: ${VALUE}`, `password: ${mask}${VALUE}`, `password: ${VALUE}${mask}`,
      `password: "${mask}${VALUE}"`, `password: "${mask}" + "${VALUE}"`,
      `password: "${mask}\\n${VALUE}"`, `password: "${mask}\\\"${VALUE}"`,
      `password: "${mask}\n  ${VALUE}"`, `password: ${mask}\n  ${VALUE}`,
      `password: ${mask}\u200b${VALUE}`, `password: ${mask}\u034f${VALUE}`,
      `password: [已脱敏:伪造]${VALUE}`, `--token [已脱敏:伪造]${VALUE}`,
      `secret: |\n  ${VALUE}`, `secret: >-\n  ${VALUE}`, `secret:\n  ${VALUE}`,
      `{"token": "${mask}", "password": "${VALUE}"}`, `token=${mask}&password=${VALUE}`,
      `token: ${mask}\npassword: ${VALUE}`, `password: "${mask}"; ${VALUE}`];
    for (const body of bodies) {
      const raw = `P1 finding F5\ntoken: ${mask}\n${body}`;
      const direct = await bridge(raw);
      expect(direct.result).toMatchObject({ rejected: GATE_REJECTED });
      expect(direct.posts).toHaveLength(0);
      const text = render(raw);
      expect(text).toContain("P1 finding F5");
      const sent = await bridge(text);
      if (peerPrSecretHit(text, COMMITS)) {
        expect(sent.result).toMatchObject({ rejected: GATE_REJECTED });
        expect(sent.posts).toHaveLength(0);
      } else {
        expect(text).not.toContain(VALUE);
        expect(sent.posts).toEqual([text]);
      }
    }
  });

  test("a legal placeholder never exempts another raw field or key prefix", async () => {
    for (const bad of [`password: ${VALUE}`, `secret: |\n  ${VALUE}`,
      "s k - abcdefghijklmnopqrstuvwx", "Bearer abc123def456", "cd".repeat(20)]) {
      const text = `token: ${REDACTED.secret}\nP1 finding F3\n${bad}`;
      expect(peerPrSecretHit(text, COMMITS)).not.toBeNull();
      const sent = await bridge(text);
      expect(sent.result).toMatchObject({ rejected: GATE_REJECTED });
      expect(sent.posts).toHaveLength(0);
    }
  });
});
