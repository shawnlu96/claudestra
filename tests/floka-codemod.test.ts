/**
 * 带允许表的机械改名（scripts/rename-floka/codemod/）的验收测试。只在临时目录里造合成仓库，不碰真仓库：
 * 真仓库的 dry-run 由 PM 手动跑。用例名里的 [验收线 N] 对应规格的四条验收线。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executePlan } from "../scripts/rename-floka/codemod/apply.ts";
import { runCli, type CliResult } from "../scripts/rename-floka/codemod/cli.ts";
import { buildPlan, renderDiff, type Plan } from "../scripts/rename-floka/codemod/plan.ts";
import { compileRules, type Rule, type RuleSet } from "../scripts/rename-floka/codemod/rules.ts";

const RULES_PATH = join(import.meta.dir, "..", "scripts", "rename-floka", "codemod", "rules.json");
const defaults = (): RuleSet => JSON.parse(readFileSync(RULES_PATH, "utf8")) as RuleSet;
const BRAND_IDS = "brand.display-docs,brand.display-comments,brand.display-jsx-text";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** 默认规则表能把每一处都归类的合成仓库：品牌文本、历史记录、协议名各有几处 */
const SYNTH: Record<string, string> = {
  "README.md": "# Claudestra\n\nClaudestra 把 agent 跑在 tmux 里（原名 Claudestra）。\n状态在 ~/.claude-orchestrator 里。\n",
  "src/app.ts": '// Claudestra 的入口\nexport const dir = process.env.CLAUDESTRA_STATE_DIR;\nexport const PURPOSE = "claudestra-invite-pop-v1";\n',
  "web/page.tsx": "export const Page = () => <h1>Claudestra</h1>;\n",
  "sessions/log.jsonl": '{"text":"Claudestra 已启动"}\n',
  "ledger/review.md": "Claudestra 第 3 轮审查\n",
};

function repo(files: Record<string, string> = SYNTH): string {
  const root = tmp("floka-cm-repo-");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** 目录哈希：每个条目的相对路径、类型、大小、修改时间、内容。多一个文件、改一个字节、碰一下 mtime 都会变 */
function treeHash(root: string): string {
  const h = createHash("sha256");
  const visit = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      h.update(`${rel}/${name}\0${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}\0${st.size}\0${st.mtimeMs}\0`);
      if (st.isDirectory()) visit(full, `${rel}/${name}`);
      else if (st.isFile()) h.update(readFileSync(full));
    }
  };
  visit(root, "");
  return h.digest("hex");
}
/** 目录里的普通文件（不跟软链：软链指到的东西不算这个目录里的） */
function listAll(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel)).sort().flatMap((name) => {
    const st = lstatSync(join(root, rel, name));
    return st.isDirectory() ? listAll(root, `${rel}${name}/`) : st.isFile() ? [`${rel}${name}`] : [];
  });
}

const home = tmp("floka-cm-home-");
const io = { env: {}, home };
const plan = (root: string, set: RuleSet = defaults()): Plan => buildPlan(root, set, io);
const cli = (root: string, args: string[]): CliResult => runCli(["--root", root, ...args], { ...io, cwd: root });
/** observe 出计划、存到扫描根外面，返回路径（相当于 PM 把 dry-run 的输出留档） */
function savedPlan(root: string): string {
  const file = join(tmp("floka-cm-plan-"), "plan.json");
  writeFileSync(file, cli(root, []).stdout);
  return file;
}
const execute = (root: string, planFile: string, target: string, rules = BRAND_IDS) =>
  cli(root, ["--mode", "on", "--plan", planFile, "--target", target, "--rules", rules]);

/** 只有品牌规则（外加给定的几条）的小规则表，用来单独验一条规则的行为 */
const BRAND_ANY: Rule = {
  id: "brand.any", class: "brand", files: ["src/**"], positions: ["comment"],
  match: "[Cc]laudestra\\w*|CLAUDESTRA_\\w+", replace: { Claudestra: "Floka", CLAUDESTRA: "FLOKA" }, reason: "测试",
};
const ruleSet = (...rules: Rule[]): RuleSet => ({ ...defaults(), rules });
const kinds = (p: Plan) => p.rejections.map((r) => r.kind);

describe("[验收线 1] 分类 diff", () => {
  test("[验收线 1] 合成品牌文本产生确定 diff", () => {
    const root = repo();
    const p = plan(root);
    expect(p.ok).toBe(true);
    expect(p.files.flatMap((f) => f.edits.map((e) => `${f.file}:${e.line} ${e.old}→${e.new} ${e.rule}/${e.position}`))).toEqual([
      "README.md:1 Claudestra→Floka brand.display-docs/text",
      "README.md:3 Claudestra→Floka brand.display-docs/text",
      "src/app.ts:1 Claudestra→Floka brand.display-comments/comment",
      "web/page.tsx:1 Claudestra→Floka brand.display-jsx-text/jsx-text",
    ]);
    expect(renderDiff(p).split("\n").slice(1, 19)).toEqual([
      "# 文件 5 · 旧名 10 处：brand 4 / protocol 3 / history 3 / 拒绝 0",
      "",
      "## brand（可执行）",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ 1 @@ brand.display-docs/text",
      "-# Claudestra",
      "+# Floka",
      "@@ 3 @@ brand.display-docs/text",
      "-Claudestra 把 agent 跑在 tmux 里（原名 Claudestra）。",
      "+Floka 把 agent 跑在 tmux 里（原名 Claudestra）。",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ 1 @@ brand.display-comments/comment",
      "-// Claudestra 的入口",
      "+// Floka 的入口",
      "--- a/web/page.tsx",
      "+++ b/web/page.tsx",
    ]);
    // 同样的源再造一份、再算一遍：digest 和整份 diff 逐字相同（不带路径、时间这类会变的东西）
    const again = plan(repo());
    expect(again.digest).toBe(p.digest);
    expect(renderDiff(again)).toBe(renderDiff(p));
    expect(cli(root, ["--format", "diff"]).stdout).toBe(renderDiff(p));
  });

  test("[验收线 1] 历史旧名保留", () => {
    const p = plan(repo());
    expect(p.kept.map((k) => `${k.file}:${k.line} ${k.rule} ×${k.count}`)).toEqual([
      "README.md:3 history.former-name ×1",
      "ledger/review.md:1 history.records ×1",
      "sessions/log.jsonl:1 history.transcripts ×1",
    ]);
    const edited = p.files.filter((f) => f.edits.length).map((f) => f.file);
    expect(edited).not.toContain("ledger/review.md");
    expect(edited).not.toContain("sessions/log.jsonl");
    // 同一行里「原名 Claudestra」那一处不动，只改前面独立成词的那一处
    expect(p.files[0]!.hunks[1]!.after).toBe("Floka 把 agent 跑在 tmux 里（原名 Claudestra）。");
  });

  test("[验收线 1] 协议旧名只报告", () => {
    const p = plan(repo());
    expect(p.manual.map((m) => `${m.file}:${m.line} ${m.token} ${m.rule}`)).toEqual([
      "README.md:4 /.claude-orchestrator protocol.state-and-checkout",
      "src/app.ts:2 process.env.CLAUDESTRA_STATE_DIR protocol.env",
      "src/app.ts:3 claudestra-invite-pop-v1 protocol.sign-and-wire-labels",
    ]);
    const olds = p.files.flatMap((f) => f.edits.map((e) => e.old));
    expect(olds.every((o) => o === "Claudestra")).toBe(true);
  });

  test("[验收线 1] 词法位置不在规则里的不执行；文件名里的旧名列为待人工", () => {
    const p = plan(repo({ "src/a.ts": 'export const title = "Claudestra";\n', "src/claudestra-extension.ts": "export {};\n" }));
    expect(p.rejections).toEqual([{ kind: "unclassified", file: "src/a.ts", line: 1, detail: "Claudestra（string）没有规则认领" }]);
    expect(p.manual.map((m) => `${m.file} ${m.rule}`)).toEqual(["src/claudestra-extension.ts builtin.path-rename"]);
    // 解析不了的文件位置未知：注释里的也不认
    expect(kinds(plan(repo({ "src/b.ts": "// Claudestra\nconst = ;\n" })))).toEqual(["unclassified"]);
  });

  test("[验收线 1] 品牌规则认领不了协议名：换一张规则表也不行", () => {
    const root = repo({ "src/env.ts": "// 读 CLAUDESTRA_STATE_DIR，Claudestra 的状态目录\n" });
    const loose = plan(root, ruleSet(BRAND_ANY));
    expect(loose.rejections.map((r) => `${r.kind} ${r.detail}`)).toEqual(["brand_over_protocol CLAUDESTRA_STATE_DIR 是协议形状，brand.any 不能按文本替换"]);
    expect(loose.files[0]!.edits.map((e) => e.old)).toEqual(["Claudestra"]);
    // 表里同时有协议规则时归协议，哪怕品牌规则的匹配更长
    const env: Rule = { id: "protocol.env", class: "protocol", match: "CLAUDESTRA", reason: "测试" };
    const both = plan(root, ruleSet(BRAND_ANY, env));
    expect(both.ok).toBe(true);
    expect(both.manual.map((m) => m.rule)).toEqual(["protocol.env"]);
  });

  test("[验收线 1] 品牌规则缺文件、词法位置、替换值任何一样，整张表作废", () => {
    const broken: Partial<Rule>[] = [{ files: undefined }, { files: ["**"] }, { positions: undefined }, { match: undefined }, { replace: undefined }, { replace: { Claudestra: "Claudestra2" } }];
    for (const patch of broken) expect(() => compileRules(ruleSet({ ...BRAND_ANY, ...patch }))).toThrow(/^rules_invalid: brand\.any/);
    expect(() => compileRules(ruleSet({ id: "history.x", class: "history", match: "x", replace: { Claudestra: "Floka" }, reason: "测试" }))).toThrow(/只有 brand 规则能带 replace/);
    expect(compileRules(defaults()).rules.length).toBe(defaults().rules.length);
  });
});

describe("[验收线 2] 开关与写入", () => {
  test("[验收线 2] 默认调用零写入", () => {
    const root = repo();
    const before = treeHash(root);
    const r = cli(root, []);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as Plan).mode).toBe("observe");
    expect(treeHash(root)).toBe(before);
    // observe 下给了目标根也不写：直接报参数错
    const target = tmp("floka-cm-out-");
    const stray = cli(root, ["--target", target, "--rules", BRAND_IDS]);
    expect([stray.code, stray.stderr]).toEqual([2, "needs_on: --target 只在 on 模式下生效（observe 不写任何文件）\n"]);
    expect(listAll(target)).toEqual([]);
    expect(treeHash(root)).toBe(before);
  });

  test("[验收线 2] off 无动作", () => {
    const root = repo();
    const before = treeHash(root);
    const target = tmp("floka-cm-out-");
    const r = cli(root, ["--mode", "off", "--plan", savedPlan(root), "--target", target, "--rules", BRAND_IDS]);
    expect([r.code, r.stdout]).toEqual([0, '{"mode":"off","skipped":true}\n']);
    expect(listAll(target)).toEqual([]);
    expect(treeHash(root)).toBe(before);
    // 连目录都不看：根不存在也照样退出 0
    expect(cli(join(root, "missing"), ["--mode", "off"]).code).toBe(0);
    const cfg = join(tmp("floka-cm-cfg-"), "config.json");
    writeFileSync(cfg, '{"rename":{"codemod":"off"}}');
    expect(cli(root, ["--config", cfg]).stdout).toBe('{"mode":"off","skipped":true}\n');
    expect(() => executePlan(root, plan(root), defaults(), { ...io, mode: "off", target, approved: BRAND_IDS.split(",") })).toThrow(/^mode_not_on/);
  });

  test("[验收线 2] on 仅在临时目录执行允许项，重复执行无新增 diff", () => {
    const root = repo();
    const before = treeHash(root);
    const planFile = savedPlan(root);
    const target = tmp("floka-cm-out-");
    const first = execute(root, planFile, target, "brand.display-docs,brand.display-comments");
    expect(first.code).toBe(0);
    const res = JSON.parse(first.stdout) as { written: string[]; unchanged: string[]; edits: number; notApproved: string[] };
    expect(res).toMatchObject({ written: ["README.md", "src/app.ts"], unchanged: [], edits: 3, notApproved: ["brand.display-jsx-text"] });
    expect(listAll(target)).toEqual(["README.md", "src/app.ts"]);
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe(SYNTH["README.md"]!.replace("# Claudestra", "# Floka").replace("\nClaudestra 把", "\nFloka 把"));
    // 协议名原样带过去，只有注释里的品牌字样变了
    expect(readFileSync(join(target, "src/app.ts"), "utf8")).toBe(SYNTH["src/app.ts"]!.replace("// Claudestra", "// Floka"));
    expect(treeHash(root)).toBe(before);

    const outHash = treeHash(target);
    const second = JSON.parse(execute(root, planFile, target, "brand.display-docs,brand.display-comments").stdout) as typeof res;
    expect(second).toMatchObject({ written: [], unchanged: ["README.md", "src/app.ts"] });
    expect(treeHash(target)).toBe(outHash);
    // 拿产物当源再算一遍：没有可执行的编辑了
    expect(plan(target).totals.brand).toBe(0);
  });

  test("[验收线 2] on 缺目标根、规则集、计划任何一样都拒绝，目标根必须是临时目录", () => {
    const root = repo();
    const planFile = savedPlan(root);
    const target = tmp("floka-cm-out-");
    const refused = (args: string[]) => cli(root, ["--mode", "on", ...args]).stderr.split(":")[0];
    expect(refused(["--target", target, "--rules", BRAND_IDS])).toBe("plan_required");
    expect(refused(["--plan", planFile, "--rules", BRAND_IDS])).toBe("target_required");
    expect(refused(["--plan", planFile, "--target", target])).toBe("rules_required");
    expect(refused(["--plan", planFile, "--target", target, "--rules", "protocol.env"])).toBe("rule_not_executable");
    expect(refused(["--plan", planFile, "--target", target, "--rules", "brand.nope"])).toBe("rule_unknown");
    expect(refused(["--plan", planFile, "--target", join(target, "missing"), "--rules", BRAND_IDS])).toBe("target_missing");
    mkdirSync(join(root, "tmp-out"));
    expect(refused(["--plan", savedPlan(root), "--target", join(root, "tmp-out"), "--rules", BRAND_IDS])).toBe("target_overlaps_root");
    // 「临时目录」按系统临时目录的真实路径认：把它换成别处，同一个目标根就不算了
    const elsewhere = tmp("floka-cm-nottmp-");
    const opts = { ...io, mode: "on" as const, target, approved: BRAND_IDS.split(","), tmpRoots: [elsewhere] };
    expect(() => executePlan(root, plan(root), defaults(), opts)).toThrow(/^target_not_temp/);
    expect(listAll(target)).toEqual([]);
  });
});

describe("[验收线 3] 拒绝执行", () => {
  /** 生成计划 → 动一下源或目标 → 执行，断言拒绝的种类，且目标根里一个文件都没写 */
  function refusedAfter(change: (root: string, target: string) => void, files = SYNTH): string {
    const root = repo(files);
    const planFile = savedPlan(root);
    const target = tmp("floka-cm-out-");
    change(root, target);
    const r = execute(root, planFile, target);
    expect(r.code).toBe(1);
    expect(listAll(target)).toEqual([]);
    return r.stderr.split(":")[0]!;
  }

  test("[验收线 3] 变更源哈希拒绝执行", () => {
    expect(refusedAfter((root) => writeFileSync(join(root, "README.md"), `${SYNTH["README.md"]}\n多一行\n`))).toBe("source_changed");
    // 没有编辑、只是被计划记了哈希的文件变了也算
    expect(refusedAfter((root) => writeFileSync(join(root, "ledger/review.md"), "Claudestra 第 4 轮审查\n"))).toBe("source_changed");
    expect(refusedAfter((root) => rmSync(join(root, "src/app.ts")))).toBe("source_changed");
    // 不带旧名的新文件不在计划里，不算源变了
    const root = repo();
    const planFile = savedPlan(root);
    writeFileSync(join(root, "notes.md"), "没有旧名\n");
    expect(execute(root, planFile, tmp("floka-cm-out-")).code).toBe(0);
  });

  test("[验收线 3] 加入未知旧名拒绝执行", () => {
    expect(refusedAfter((root) => writeFileSync(join(root, "src/new.ts"), "export const installClaudestraCli = 1;\n"))).toBe("unclassified");
    // 计划本身就带未分类命中时同样不执行
    const root = repo({ ...SYNTH, "src/new.ts": "export const installClaudestraCli = 1;\n" });
    const target = tmp("floka-cm-out-");
    expect(plan(root).ok).toBe(false);
    expect(execute(root, savedPlan(root), target).stderr).toStartWith("unclassified: src/new.ts:1 installClaudestraCli（code）没有规则认领");
    expect(listAll(target)).toEqual([]);
  });

  test("[验收线 3] symlink 逃逸拒绝执行", () => {
    const outside = tmp("floka-cm-outside-");
    writeFileSync(join(outside, "secret.md"), "# Claudestra\n");
    // 源里多出一个指到根外面的软链
    expect(refusedAfter((root) => symlinkSync(join(outside, "secret.md"), join(root, "linked.md")))).toBe("symlink_escape");
    // 计划里的文件被换成指到根外面的软链
    expect(refusedAfter((root) => {
      rmSync(join(root, "README.md"));
      symlinkSync(join(outside, "secret.md"), join(root, "README.md"));
    })).toBe("symlink_escape");
    // 目标根里的子目录是指到外面的软链：写过去就出了临时目录
    const before = treeHash(outside);
    expect(refusedAfter((_root, target) => symlinkSync(outside, join(target, "src")))).toBe("target_escape");
    expect(refusedAfter((_root, target) => symlinkSync(join(outside, "secret.md"), join(target, "README.md")))).toBe("target_escape");
    expect(treeHash(outside)).toBe(before);
    // 目录软链不跟：外面的内容进不了计划
    const root = repo();
    symlinkSync(outside, join(root, "docs"));
    expect(plan(root).files.map((f) => f.file)).not.toContain("docs/secret.md");
    expect(kinds(plan(root))).toEqual(["symlink_escape"]);
  });

  test("[验收线 3] 计划被改、路径出根、二进制输入都拒绝", () => {
    const root = repo();
    const target = tmp("floka-cm-out-");
    const good = plan(root);
    const run = (p: Plan) => () => executePlan(root, p, defaults(), { ...io, mode: "on", target, approved: BRAND_IDS.split(",") });
    const moved = { ...good, files: good.files.map((f, i) => (i ? f : { ...f, file: "../escape.md" })) };
    expect(run(moved)).toThrow(/^path_escape/);
    expect(run({ ...good, files: good.files.slice(1) })).toThrow(/^plan_tampered/);
    expect(run({ ...good, rulesDigest: "0" })).toThrow(/^plan_tampered/);
    expect(listAll(target)).toEqual([]);
    expect(run(good)().written).toEqual(["README.md", "src/app.ts", "web/page.tsx"]);

    const bin = repo({ ...SYNTH, "assets/logo.bin": "\0\u0001Claudestra\0" });
    expect(plan(bin).rejections).toEqual([{ kind: "binary_input", file: "assets/logo.bin", line: 0, detail: "二进制或超限文件里有 1 处旧名，不做文本替换" }]);
    expect(execute(bin, savedPlan(bin), tmp("floka-cm-out-")).stderr).toStartWith("binary_input:");
    // 不带旧名的二进制只是跳过
    expect(plan(repo({ ...SYNTH, "assets/logo.bin": "\0\u0001\0" })).ok).toBe(true);
  });

  test("[验收线 3] 依赖、构建物、状态目录、外部安装副本不读", () => {
    const junk = "export const installClaudestraCli = 1;\n";
    const root = repo({ ...SYNTH, "node_modules/x/index.js": junk, "web/.next/chunk.js": junk, "dist/app.js": junk, "vendor/claudestra/a.ts": junk, ".git/config": junk });
    const p = plan(root);
    expect(p.ok).toBe(true);
    expect(p.exclusions.skipped).toEqual([
      { path: ".git/", reason: "版本库内部" },
      { path: "dist/", reason: "构建物" },
      { path: "node_modules/", reason: "依赖" },
      { path: "vendor/", reason: "外部 pin 的副本" },
      { path: "web/.next/", reason: "构建物" },
    ]);
    const state = join(home, ".claude-orchestrator");
    mkdirSync(join(state, "sessions"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    expect(() => plan(state)).toThrow(/^refuse_state_dir/);
    expect(() => plan(join(state, "sessions"))).toThrow(/^refuse_state_dir/);
    expect(() => plan(home)).toThrow(/^refuse_/);
    expect(() => plan(join(home, ".local", "bin"))).toThrow(/^refuse_install_copy/);
    expect(() => buildPlan(root, defaults(), { home, env: { CLAUDESTRA_STATE_DIR: ` ${root} ` } })).toThrow(/^refuse_state_dir/);
    writeFileSync(join(state, "config.json"), '{"rename":{"codemod":"on"}}');
    expect(cli(root, ["--config", join(state, "config.json")]).stderr).toStartWith("refuse_state_input:");
  });
});
