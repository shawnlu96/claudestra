import { expect, test } from "bun:test";
import { scrubSharedLedger } from "../src/lib/shared-ledger-scrub.js";
import {
  scrubSessionPage, scrubTeamBody, TEAM_BODY_MASK, TEAM_BODY_SCRUB_VERSION, TEAM_BODY_TOOL_OUTPUT_MAX,
} from "../src/lib/team-body-scrub.js";

const context = { identity: { username: "fake-user", hostname: "fake-host" } };
/** The upload gate read directly, as a caller that only truncates and then detects would use it. */
const gateHits = (text: string): boolean => {
  try { scrubSharedLedger({ description: text }, (value) => value, context); return false; }
  catch { return true; }
};
/** Fixtures are assembled from pieces so no scanner reads this file as holding a key. */
const KEY = `sk-${"FAKE".repeat(6)}`;
const PEM_BODY = ["MIIEvFAKE+fake/FAKE+fake/FAKE+fake/FAKE+fake", "q7r/FAKE+fake/FAKE+fake/FAKE+fake/FAKE+fake", "zz9/FAKE+fake/FAKE=="];
const pem = (gap: string): string =>
  [`-----BEGIN RSA ${"PRIVATE"} KEY-----`, PEM_BODY[0], PEM_BODY[1], PEM_BODY[2], `-----END RSA ${"PRIVATE"} KEY-----`].join(gap);
const clean = (result: { text: string }, ...pieces: string[]): void => {
  for (const piece of pieces) expect(result.text).not.toContain(piece);
  expect(gateHits(result.text)).toBe(false);
};

test("a secret in multi-line JSON or YAML masks its whole segment", () => {
  const json = ["intro stays", "", "{", '  "name": "deploy",', `  "apiKey": "${KEY}",`, '  "region": "eu-fake"', "}", "", "outro stays"].join("\n");
  const out = scrubTeamBody(json, context);
  expect(out).toEqual({ text: `intro stays\n\n${TEAM_BODY_MASK}\n\noutro stays`, maskedSegments: 1, refused: false, scrubVersion: TEAM_BODY_SCRUB_VERSION });
  clean(out, KEY, "FAKE", "deploy", "eu-fake");

  // The block scalar runs on past a blank line: its second half is clean when read alone and is masked all the same.
  const yaml = ["service:", "  password: |", "    first-half-of-value", "", "    second-half-of-value", "", "after stays"].join("\n");
  const scalar = scrubTeamBody(yaml, context);
  expect(scalar.text).toBe(`${TEAM_BODY_MASK}\n\n${TEAM_BODY_MASK}\n\nafter stays`);
  expect(scalar.maskedSegments).toBe(2);
  expect(gateHits("    second-half-of-value")).toBe(false);
  clean(scalar, "first-half", "second-half");
});

test("a token in a fenced code block masks the block, blank lines inside it included", () => {
  const text = ["Run it like this:", "", "```sh", "export REGION=eu-fake", "", `curl -H "Authorization: Bearer ${KEY}" fake.example`, "```", "", "Then check the log."].join("\n");
  const out = scrubTeamBody(text, context);
  expect(out.text).toBe(`Run it like this:\n\n${TEAM_BODY_MASK}\n\nThen check the log.`);
  expect(out.maskedSegments).toBe(1);
  clean(out, KEY, "eu-fake", "curl", "```");
  // An unclosed fence runs to the end of the text.
  const open = scrubTeamBody(`before\n\n~~~\ntoken=${KEY}\n\ntail in the same block`, context);
  expect(open.text).toBe(`before\n\n${TEAM_BODY_MASK}`);
});

test("a private key block is one segment across paragraph boundaries", () => {
  for (const gap of ["\n", "\n\n", "\n\n\n"]) {
    const out = scrubTeamBody(`Key below.\n\n${pem(gap)}\n\nKey above.`, context);
    expect(out.text).toBe(`Key below.\n\n${TEAM_BODY_MASK}\n\nKey above.`);
    expect(out.maskedSegments).toBe(1);
    clean(out, "BEGIN", "END", ...PEM_BODY, "FAKE");
  }
  // Red line: read paragraph by paragraph the body lines trip nothing, and a summary cut inside the block hides the rest.
  expect(gateHits(PEM_BODY[1]!)).toBe(false);
  const summary = `Key below.\n\n${pem("\n\n")}`.slice(0, 80);
  expect(scrubTeamBody(summary, context).text).toBe(`Key below.\n\n${TEAM_BODY_MASK}`);
  // A block cut before its END line runs to the end of the text.
  expect(scrubTeamBody(`a\n\n${pem("\n\n").split("-----END")[0]}\n\ntrailing`, context).text).toBe(`a\n\n${TEAM_BODY_MASK}`);
});

test("a key split by a blank line masks both halves", () => {
  const out = scrubTeamBody(`first\n\ns k -\n\n${"FAKE".repeat(6)}\n\nlast`, context);
  expect(out).toMatchObject({ text: `first\n\n${TEAM_BODY_MASK}\n\n${TEAM_BODY_MASK}\n\nlast`, maskedSegments: 2, refused: false });
  clean(out, "FAKE", "s k");
});

test("text without sensitive content is returned verbatim", () => {
  const text = ["", "# 标题 Title", "", "正文第一段，引用 `src/lib/team-body-scrub.ts` 与 head 69eb8beb。  ", "second line\r", "", "",
    "```ts", "const tokens = 12; // maxTokens stays", "", "export {};", "```", "", "- item one", "- item two", "", `{"stage": "review", "pr": 1383}`, ""].join("\n");
  expect(scrubTeamBody(text, context)).toEqual({ text, maskedSegments: 0, refused: false, scrubVersion: TEAM_BODY_SCRUB_VERSION });
  expect(scrubTeamBody("", context)).toMatchObject({ text: "", maskedSegments: 0, refused: false });
  expect(scrubSessionPage([{ text }, { text, tool: true }], context).map((r) => r.text)).toEqual([text, text]);
});

test("a hit that survives masking refuses and returns no text", () => {
  // Detector boundary: the mask itself trips a value this instance must never send.
  const marked = scrubTeamBody(`plain\n\napi_key: ${KEY}\n\nplain`, { ...context, personalValues: ["遮蔽"] });
  expect(marked).toEqual({ text: "", maskedSegments: 1, refused: true, scrubVersion: TEAM_BODY_SCRUB_VERSION });
  // Detector boundary: no identity to test against fails closed, whatever the text.
  expect(scrubTeamBody("plain text", { identity: { username: "", hostname: "" } })).toMatchObject({ text: "", refused: true });
  // More cross-paragraph splits than the bounded search resolves: refused, never half masked.
  const splits = Array.from({ length: 6 }, (_, i) => `note ${i}\n\ns k -\n\n${"FAKE".repeat(6)}`).join("\n\n");
  expect(scrubTeamBody(splits, context)).toMatchObject({ text: "", refused: true });
  expect(scrubSessionPage([{ text: "ok" }, { text: splits, tool: true }], context).map((r) => [r.text, r.refused])).toEqual([["ok", false], ["", true]]);
});

test("a tool output is scrubbed before it is cut, so a key under the cut leaves no piece", () => {
  for (const inside of [3, 8, 14]) {
    const lead = `${"log line\n".repeat(400)}`.slice(0, TEAM_BODY_TOOL_OUTPUT_MAX - 7 - inside);
    const output = `${lead}\nvalue ${KEY} tail\n\nmore output\n`;
    // Red line: cut first, detect after. The piece of the key left before the cut trips no rule and would be sent.
    const naive = output.slice(0, TEAM_BODY_TOOL_OUTPUT_MAX);
    expect(naive.endsWith(KEY.slice(0, inside))).toBe(true);
    expect(gateHits(naive)).toBe(false);

    const [out] = scrubSessionPage([{ text: output, tool: true }], context);
    expect(out).toMatchObject({ maskedSegments: 1, refused: false, scrubVersion: TEAM_BODY_SCRUB_VERSION });
    expect(out!.text.length).toBeLessThanOrEqual(TEAM_BODY_TOOL_OUTPUT_MAX);
    clean(out!, "sk-", "FAKE", "value");
  }
  // The mask is never cut in half; a mask that does not fit is dropped and not counted.
  const [edge] = scrubSessionPage([{ text: `${"x".repeat(TEAM_BODY_TOOL_OUTPUT_MAX - 5)}\n\ntoken=${KEY}`, tool: true }], context);
  expect(edge).toMatchObject({ text: `${"x".repeat(TEAM_BODY_TOOL_OUTPUT_MAX - 5)}\n\n`, maskedSegments: 0, refused: false });
  // Non-tool messages are not cut.
  const long = "word ".repeat(1000);
  expect(scrubSessionPage([{ text: long }, { text: long, tool: true }], context).map((r) => r.text.length)).toEqual([5000, TEAM_BODY_TOOL_OUTPUT_MAX]);
});
