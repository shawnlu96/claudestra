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

test("a key split by a blank line is masked as one run, its tail included", () => {
  const out = scrubTeamBody(`first\n\ns k -\n\n${"FAKE".repeat(6)}\n\n(last)`, context);
  expect(out).toMatchObject({ text: `first\n\n${TEAM_BODY_MASK}\n\n(last)`, maskedSegments: 1, refused: false });
  clean(out, "FAKE", "s k");
  // The first paragraph trips the gate alone; the rest of the same key after the blank line trips nothing and goes with it.
  const tail = "tailTAILtailTAIL";
  expect(gateHits(tail)).toBe(false);
  for (const head of [KEY, `Authorization: Bearer ${"fake1".repeat(4)}`, `ghp_${"FAKE".repeat(6)}`]) {
    const split = scrubTeamBody(`first.\n\n${head}\n\n${tail}\n\n。last`, context);
    expect(split).toMatchObject({ text: `first.\n\n${TEAM_BODY_MASK}\n\n。last`, maskedSegments: 1, refused: false });
    clean(split, "FAKE", "fake1", tail);
  }
});

test("spans are read on the gate's normalized view and masked in the original", () => {
  const ZW = "​";
  const wide = (word: string): string => [...word].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join("");
  const cases: [string, string, string[]][] = [
    // The marker is split by a zero-width character and the key body lies on both sides of a blank line.
    ["pem", [`-----BEGIN RSA PRI${ZW}VATE KEY-----`, PEM_BODY[0], "", PEM_BODY[1], PEM_BODY[2], `-----END RSA PRI${ZW}VATE KEY-----`].join("\n"), [...PEM_BODY, "BEGIN", "END"]],
    // The gate removes blanks before it looks for the marker, so a marker spread over lines is the same marker.
    ["pem spread", ["- - - - - B E G I N", `PRIV`, "", `ATE KEY-----`, PEM_BODY[0], "", PEM_BODY[1], "", "-----E N D PRIVATE", "KEY-----"].join("\n"), [...PEM_BODY, "ATE KEY", "E N D"]],
    ["yaml", [`${wide("password")}: |`, "    first-half-of-value", "", "    second-half-of-value"].join("\n"), ["first-half", "second-half"]],
    ["quoted", [`"pass${ZW}word": "first-half-of-value`, "", `second-half-of-value"`].join("\n"), ["first-half", "second-half"]],
    // A value that only looks masked already is not trusted, and neither are its continuation lines.
    ["mask lookalike", ["password: [已脱敏:密钥]|", "  first-half-of-value", "", "  second-half-of-value"].join("\n"), ["first-half", "second-half"]],
    ["wide key", `${wide("sk-")}${"FAKE".repeat(3)}\n\n${wide("FAKE".repeat(3))}`, ["FAKE", wide("FAKE")]],
  ];
  for (const [name, secret, pieces] of cases) {
    expect([name, gateHits(secret)]).toEqual([name, true]);
    const out = scrubTeamBody(`Before stays.\n\n${secret}\n\n（after stays）`, context);
    expect([name, out.refused, out.text.replaceAll(TEAM_BODY_MASK, "#")]).toEqual([name, false, expect.stringMatching(/^Before stays\.\n\n#(\n\n#)*\n\n（after stays）$/)]);
    clean(out, ...pieces);
  }
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
  // More cross-paragraph hits than the bounded search resolves: refused, never half masked.
  const known = { ...context, knownSecrets: ["alpha line\n\nbeta line"] };
  const splits = Array.from({ length: 6 }, (_, i) => `note ${i}.\n\nalpha line\n\nbeta line`).join("\n\n");
  expect(scrubTeamBody(splits.split("\n\n").slice(0, 3).join("\n\n"), known)).toMatchObject({ text: `note 0.\n\n${TEAM_BODY_MASK}\n\n${TEAM_BODY_MASK}`, refused: false });
  expect(scrubTeamBody(splits, known)).toMatchObject({ text: "", refused: true });
  expect(scrubSessionPage([{ text: "ok" }, { text: splits, tool: true }], known).map((r) => [r.text, r.refused])).toEqual([["ok", false], ["", true]]);
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
  // Blanks stretch a key without limit, so no fixed look-ahead past the cut is enough: the whole output is scrubbed first.
  for (const gap of [70_000, 700_000]) {
    const stretched = `${KEY.slice(0, 7)}${" ".repeat(gap)}${KEY.slice(7)}\n\n（after）`;
    expect(gateHits(stretched)).toBe(true);
    expect(gateHits(stretched.slice(0, gap))).toBe(false);
    const [far] = scrubSessionPage([{ text: stretched, tool: true }], context);
    expect(far).toEqual({ text: `${TEAM_BODY_MASK}\n\n（after）`, maskedSegments: 1, refused: false, scrubVersion: TEAM_BODY_SCRUB_VERSION });
    clean(far!, "sk-", "FAKE");
  }
  // The same for a field value whose key is in view and whose continuation lines begin far below the cut.
  const [field] = scrubSessionPage([{ text: `token: |\n${"\n".repeat(80_000)}  far-away-value\n`, tool: true }], context);
  expect(field).toMatchObject({ maskedSegments: 1, refused: false });
  expect(field!.text.trimEnd()).toBe(TEAM_BODY_MASK);
  clean(field!, "far-away");
  // Paragraphs that start past the cut are masked unjudged (they are dropped anyway); what is kept is judged as before.
  const paragraphs = "plain paragraph.\n\n".repeat(500);
  const [kept] = scrubSessionPage([{ text: `${paragraphs}${KEY}`, tool: true }], context);
  expect(kept).toMatchObject({ text: paragraphs.slice(0, TEAM_BODY_TOOL_OUTPUT_MAX), maskedSegments: 0, refused: false });
  // The mask is never cut in half; a mask that does not fit is dropped and not counted.
  const [edge] = scrubSessionPage([{ text: `${"x".repeat(TEAM_BODY_TOOL_OUTPUT_MAX - 5)}\n\ntoken=${KEY}`, tool: true }], context);
  expect(edge).toMatchObject({ text: `${"x".repeat(TEAM_BODY_TOOL_OUTPUT_MAX - 5)}\n\n`, maskedSegments: 0, refused: false });
  // Non-tool messages are not cut.
  const long = "word ".repeat(1000);
  expect(scrubSessionPage([{ text: long }, { text: long, tool: true }], context).map((r) => r.text.length)).toEqual([5000, TEAM_BODY_TOOL_OUTPUT_MAX]);
});

test("a YAML block scalar is masked to its end whatever its header says", () => {
  // The gate's field redactor knows "|", ">" and a chomping sign only; any other header reads to it as a plain value whose
  // continuation stops at the first line that looks like a field, and the tail after a blank line then names no field.
  const tail = "second-half-of-value";
  expect(gateHits(`  ${tail}`)).toBe(false);
  for (const header of ["|", "|2", ">2", "|2-", "|+2", "| # comment", "> # comment", "!!str |", "&anchor >-"]) {
    for (const [lead, pad] of [["", "  "], ["  ", "    "], ["- ", "    "], ["\t", "\t  "]] as const) {
      const yaml = [`${lead}password: ${header}`, `${pad}first: value`, "", `${pad}${tail}`, "", `${pad}  deeper: tail`, "after: stays"].join("\n");
      expect([header, gateHits(yaml)]).toEqual([header, true]);
      const body = scrubTeamBody(`Before stays.\n\n${yaml}`, context);
      const [tool] = scrubSessionPage([{ text: `Before stays.\n\n${yaml}`, tool: true }], context);
      for (const out of [body, tool!]) {
        expect([header, lead, out.refused, out.text]).toEqual([header, lead, false, `Before stays.\n\n${TEAM_BODY_MASK}\n\n${TEAM_BODY_MASK}\n\n${TEAM_BODY_MASK}`]);
        clean(out, "first", "second-half", "deeper", "after");
      }
    }
  }
  // The value ends at the first line indented no deeper than its field; paragraphs after that are judged on their own.
  const ended = scrubTeamBody(["password: |2", "  first: value", "", `  ${tail}`, "", "plain paragraph stays", "", "  indented stays"].join("\n"), context);
  expect(ended).toMatchObject({ text: `${TEAM_BODY_MASK}\n\n${TEAM_BODY_MASK}\n\nplain paragraph stays\n\n  indented stays`, maskedSegments: 2, refused: false });
});
