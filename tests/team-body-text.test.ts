/** team-project-TEAMSCRUB: the text the body upload hands to the scrub (src/lib/team-body-text.ts), alone and through a pass. */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewOf } from "@/features/collab/team-body/team-body-model";
import { DEPLOY_LABEL_PREFIX } from "../src/lib/scheduler-deploy.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { scrubTeamBody, TEAM_BODY_MASK, TEAM_BODY_SCRUB_VERSION } from "../src/lib/team-body-scrub.js";
import { teamBodyReviewText, teamBodyScrubHeads, teamBodySourceText } from "../src/lib/team-body-text.js";
import { SCRUB } from "./shared-ledger-mirror-fixture.test.js";
import { world } from "./team-body-sync-fixture.test.js";

const KEY = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const ORG = "testorg-zz", REPO = "secret-repo-zz", PRIVATE = `repo:${ORG}/${REPO}`;
const VERDICT = "审查结论 changes · P0 0 / P1 2 / P2 0";
const reviewData = (probe: string) => JSON.stringify({ verdict: "changes", p0: 0, p1: 2, p2: 0, path: "/Users/someone/reviews/c5-existing-r1.md",
  findings: [{ findingId: "race-1", severity: "P1", probe }, { findingId: "race-2", severity: "P1", description: "退款没有幂等", probe: "二次退款" }] });
const insertReview = (w: Awaited<ReturnType<typeof world>>, text: string, data: string) =>
  w.f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (1, 'agent-r', ?, 'c5-existing', 'review', ?, ?)").run(w.f.project, text, data);
const records = (w: Awaited<ReturnType<typeof world>>) => w.uploads().flatMap((u) => u.records);

test("[验收线 1] a review is one paragraph per verdict, finding (with its probe) and report; the text follows untouched", () => {
  const text = teamBodyReviewText("正文一\n正文二", reviewData("并发提交会重复扣款"));
  expect(text).toBe([VERDICT, "- [P1] race-1\n  复现：并发提交会重复扣款", "- [P1] race-2：退款没有幂等\n  复现：二次退款",
    "报告：c5-existing-r1.md（全文在主场）", "正文一\n正文二"].join("\n\n"));
  expect(teamBodyReviewText("只有正文", "{}")).toBe("只有正文");
  expect(teamBodyReviewText("", "not json")).toBe("");
  expect(reviewOf(text)).toEqual({ data: { verdict: "changes", p0: 0, p1: 2, p2: 0 }, text: text.slice(VERDICT.length).trim() });
});

test("[验收线 1] a secret in one probe masks that finding alone: the verdict and the other finding go up as written", async () => {
  const w = await world("on");
  try {
    insertReview(w, "正文一\n正文二", reviewData(`token ${KEY}。`));
    await w.pass();
    const [review] = records(w);
    expect(review).toMatchObject({ kind: "review", maskedSegments: 1, scrubVersion: 2 });
    expect(TEAM_BODY_SCRUB_VERSION).toBe(2);
    expect(review!.text).toBe([VERDICT, TEAM_BODY_MASK, "- [P1] race-2：退款没有幂等\n  复现：二次退款",
      "报告：c5-existing-r1.md（全文在主场）", "正文一\n正文二"].join("\n\n"));
    expect(JSON.stringify(w.uploads())).not.toContain(KEY);
    const web = reviewOf(review!.text);
    expect(web.data).toEqual({ verdict: "changes", p0: 0, p1: 2, p2: 0 });
    expect(web.text).toBe(review!.text.slice(VERDICT.length).trim());
  } finally { await w.f.close(); }
});

test("[验收线 2] a known commit in the text goes up; any other 40 / 64 hex is still masked; the scrub is asked about both sources", async () => {
  const w = await world("on");
  try {
    const head = "a".repeat(40), known = "0123456789abcdef".repeat(2) + "01234567", other40 = "9".repeat(39) + "e", other64 = "8".repeat(63) + "f";
    w.f.db.prepare("UPDATE tasks SET headSHA = ? WHERE id = 'c5-existing'").run(head);
    w.note(`已合并 ${known.toUpperCase()}，主干前进`);
    w.note(`说明\n\n不认识的 ${other40}`);
    w.note(`说明\n\n摘要 ${other64}`);
    const repoCommits = new Set([head, known]), asked: string[][] = [];
    const scrub = async (heads: readonly string[]) => {
      asked.push([...heads]);
      return { ...SCRUB, commits: new Set(heads.filter((h) => repoCommits.has(h))) };
    };
    await runSharedLedgerMirrorPass({ ...w.deps(), scrub });
    expect(records(w).map((r) => [r.text, r.maskedSegments])).toEqual([[`已合并 ${known.toUpperCase()}，主干前进`, 0],
      [`说明\n\n${TEAM_BODY_MASK}`, 1], [`说明\n\n${TEAM_BODY_MASK}`, 1]]);
    expect(asked.some((heads) => [head, known, other40, other64].every((h) => heads.includes(h)))).toBe(true);
    // Not a commit of the repository: never let through because the text named it.
    expect(JSON.stringify(w.uploads())).not.toContain(other40);
    expect(JSON.stringify(w.uploads())).not.toContain(other64);
  } finally { await w.f.close(); }
  expect(teamBodyScrubHeads(["h1"], [`x ${"B".repeat(40)} ${"c".repeat(32)}`, "h1", ""])).toEqual(["h1", "b".repeat(40)]);
});

test("[验收线 3] a historical deploy receipt reads like a new one and is not masked", () => {
  const label = `${DEPLOY_LABEL_PREFIX}0123456789abcdef0123456789abcdef`;
  const old = `自动部署：running（提交部署任务 ${label}，固定部署 main abcdef012345）`;
  const sent = teamBodySourceText("event", old);
  expect(sent).toBe("自动部署：running（提交部署任务 deploy.89abcdef，固定部署 main abcdef012345）");
  expect(scrubTeamBody(old, SCRUB).maskedSegments).toBe(1);
  expect(scrubTeamBody(sent, SCRUB)).toMatchObject({ text: sent, maskedSegments: 0, refused: false });
  // Only the label's own shape: a longer hex is no label and stays for the gate to mask.
  expect(teamBodySourceText("event", `${label}0`)).toBe(`${label}0`);
  expect(teamBodySourceText("spec", label)).toBe(label);
});

const SPEC = `# 规格

<!-- 别的注释照留 -->
正文里提到 <!-- ask-default:ask_x1 --> 不是整行，不动。

<!-- ask-default:ask_mv6zxo8qedfa6bb256 -->
## 自动定（2026-10-14T00:00:00.000Z）

问题原文：
> 用哪种排版？

默认做法：
> 按发现成段

结论：按执行者默认做法定。PM 若已另行答复，以规格里 PM 定为准。
  <!-- /ask-default:ask_mv6zxo8qedfa6bb256 -->\t
`;

test("[验收线 4] ask-default marker lines leave the uploaded spec; the conclusion is not masked and other comments stay", async () => {
  expect(scrubTeamBody(SPEC.replace("正文里提到 <!-- ask-default:ask_x1 --> 不是整行，不动。\n", ""), SCRUB).maskedSegments).toBe(1);
  const sent = teamBodySourceText("spec", SPEC);
  expect(sent).toBe(SPEC.split("\n").filter((line) => !/^\s*<!-- \/?ask-default:ask_mv/.test(line)).join("\n"));
  expect(teamBodySourceText("event", SPEC)).toBe(SPEC);
  expect(teamBodySourceText("spec", "")).toBe("");
  const w = await world("on");
  try {
    const file = SPEC.replace("正文里提到 <!-- ask-default:ask_x1 --> 不是整行，不动。\n", "");
    writeFileSync(join(w.docs, "tasks", "c5-existing.md"), file);
    await w.pass();
    const [spec] = records(w);
    expect(spec).toMatchObject({ kind: "spec", maskedSegments: 0 });
    expect(spec!.text).not.toContain("ask-default");
    expect(spec!.text).toContain("结论：按执行者默认做法定。PM 若已另行答复，以规格里 PM 定为准。");
    expect(spec!.text).toContain("<!-- 别的注释照留 -->");
    expect(spec!.text).toBe(file.split("\n").filter((line) => !line.includes("ask-default")).join("\n"));
  } finally { await w.f.close(); }
});

test("[验收线 5] private-repo paths never leave: list items are dropped whole, inline ones become the placeholder", async () => {
  const body = (lead: string) => `${lead}：见 ${PRIVATE}/src/pay/**/*.ts 的实现\n\n范围：\n- \`${PRIVATE}/src/pay/*.ts\`\n- src/lib/a.ts\n* ${PRIVATE}\n1. ${PRIVATE}/docs/x.md  \n收尾`;
  const sentBody = (lead: string) => `${lead}：见 [私仓路径] 的实现\n\n范围：\n- src/lib/a.ts\n收尾`;
  for (const kind of ["event", "review", "spec"] as const) expect(teamBodySourceText(kind, body("说明"))).toBe(sentBody("说明"));
  // Part of another word, or not the marker's shape: left alone.
  for (const kept of ["xrepo:a/b", "my-repo:a/b", "a.repo:a/b", "repo:only-org", "repo: a/b"]) expect(teamBodySourceText("event", kept)).toBe(kept);
  expect(teamBodySourceText("event", `(${PRIVATE}/a)、“${PRIVATE}”；中文后repo:a/b/c，\`${PRIVATE}/x y\``))
    .toBe("([私仓路径])、“[私仓路径]”；中文后[私仓路径]`[私仓路径] y`");
  const w = await world("on");
  try {
    w.note(body("事件"));
    insertReview(w, body("审查"), reviewData(`${PRIVATE}/src/pay/refund.ts:20 二次退款`));
    writeFileSync(join(w.docs, "tasks", "c5-existing.md"), `# 规格\n\n${body("规格")}\n`);
    await w.pass();
    const sent = records(w);
    expect(sent.map((r) => r.kind)).toEqual(["event", "review", "spec"]);
    const wire = JSON.stringify(w.requests);
    for (const leaked of ["repo:", ORG, REPO]) expect(wire).not.toContain(leaked);
    expect(sent[0]!.text).toBe(sentBody("事件"));
    expect(sent[1]!.text).toContain("- [P1] race-1\n  复现：[私仓路径] 二次退款");
    expect(sent[1]!.text.endsWith(sentBody("审查"))).toBe(true);
    expect(sent[2]!.text).toBe(`# 规格\n\n${sentBody("规格")}\n`);
    expect(sent.map((r) => r.maskedSegments)).toEqual([0, 0, 0]);
  } finally { await w.f.close(); }
});

test("observe counts through the same rewrites: an old deploy receipt is no longer a masked segment", async () => {
  const w = await world("observe");
  try {
    w.note(`自动部署：running（提交部署任务 ${DEPLOY_LABEL_PREFIX}${"0123456789abcdef".repeat(2)}）`);
    await w.pass();
    expect(w.observed()[0]).toMatchObject({ data: { upload: 1, masked: 0, refused: 0 } });
  } finally { await w.f.close(); }
});
