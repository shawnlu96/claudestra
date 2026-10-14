/**
 * CI 责任选集放行（merge-arch-CISEL1）：一片测试红了，红的那几条既不在这张 PR 的责任选集里、也不在它的改动里时，这一片可以按回执放行。
 * 这里只有纯判定与回执格式；分片接线是 scripts/ci-selected-verdict.ts，证明侧是 scripts/ci-proof-artifact.ts 与 lib/ci-proof.ts。
 * 拿不准的一律不放行：责任选集是 "all"、失败在选集里或改动里、日志解析不全、测试没完整跑完、非测试步骤红。
 * docs/architecture/ci-selected-gate.md，tests/ci-selected-verdict.test.ts。
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { type CiFailure, parseFailedLog } from "./scheduler-merge-ci-rerun-log.js";

export type CiSelectedMode = "off" | "observe" | "on";
/** 受信仓库变量 CI_SELECTED_GATE：显式 off / on 之外（不设、observe、未知值）都读作 observe。 */
export function ciSelectedMode(raw: unknown): CiSelectedMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "off" || v === "on" ? v : "observe";
}

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** plan.json 的 responsibility：这张 PR 本该负责的测试文件；任何兜底全量都是 "all"。执行范围（scope / tests / shards）与它无关。 */
export interface CiResponsibility { tests: string[] | "all"; digest: string; fallbackReasons: string[] }
export const responsibilityDigest = (tests: readonly string[] | "all"): string => sha256(JSON.stringify(tests === "all" ? "all" : [...tests].sort()));
export function responsibility(tests: readonly string[] | "all", fallbackReasons: string[] = []): CiResponsibility {
  const t = tests === "all" ? "all" : [...new Set(tests)].sort();
  return { tests: t, digest: responsibilityDigest(t), fallbackReasons };
}
/** 从 plan.json 的值里读责任选集；缺字段、类型不对或 digest 与内容不符都读作 null（不放行）。 */
export function readResponsibility(raw: unknown): CiResponsibility | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const tests = r.tests === "all" ? "all" : Array.isArray(r.tests) && r.tests.every((t) => typeof t === "string") ? r.tests as string[] : null;
  if (tests === null || typeof r.digest !== "string" || r.digest !== responsibilityDigest(tests)) return null;
  const reasons = Array.isArray(r.fallbackReasons) ? r.fallbackReasons.filter((x): x is string => typeof x === "string") : [];
  return { tests, digest: r.digest, fallbackReasons: reasons };
}

export interface SelectedVerdictInput {
  /** 冻结的责任选集；null = 读不到 / 对不上 */
  responsibility: CiResponsibility | null;
  /** 本片的失败（parseFailedLog 的结果）；null = 解析不全、被截断或归属不到文件 */
  failures: readonly CiFailure[] | null;
  /** PR 改动的文件；null = 读不出 */
  changed: readonly string[] | null;
  /** 分到本片的测试都跑完了（bun 正常以测试失败退出、日志跑到汇总行、跑过的文件恰好是分到的） */
  complete: boolean;
  /** 非测试步骤（typecheck / guard / 入口构建 / web 构建）的结果；success、skipped（本片不跑）、pending（在测试步骤之后才跑）之外都算红 */
  steps: Readonly<Record<string, string>>;
}
export interface SelectedVerdict { allow: boolean; reason: string; outOfScope: { file: string; name: string }[] }

const NOT_RED = new Set(["success", "skipped", "pending"]);
/** 放行判定自己的输入：PR 改了它们，就不拿它们给自己放行（PR 跑的是自己那份代码，这条只防误改，真正的关口是审查）。 */
const SELF = [/^scripts\/ci-selected-verdict\.ts$/, /^src\/lib\/ci-selected-verdict[\w-]*\.ts$/, /^src\/lib\/scheduler-merge-ci-rerun-log\.ts$/,
  /^scripts\/ci-related-plan\.ts$/, /^src\/lib\/canonical-json\.ts$/];
const TEST_FILE = /^tests\/\S+\.test\.[cm]?[jt]sx?$/;
const deny = (reason: string): SelectedVerdict => ({ allow: false, reason, outOfScope: [] });
const norm = (p: string) => p.replace(/^\.\//, "");

/** 唯一的放行判定（纯函数）。顺序即理由的优先级：先挡结构性问题，再看每条失败落在哪。 */
export function judgeSelected(input: SelectedVerdictInput): SelectedVerdict {
  const r = input.responsibility;
  if (!r) return deny("没有可核对的责任选集");
  if (r.tests === "all") return deny(`责任选集是 all${r.fallbackReasons.length ? `（${r.fallbackReasons.slice(0, 3).join("；")}）` : ""}`);
  const red = Object.entries(input.steps).filter(([, v]) => !NOT_RED.has(v));
  if (red.length) return deny(`非测试步骤没成功：${red.map(([k, v]) => `${k}=${v || "未知"}`).join(", ")}`);
  if (!input.complete) return deny("选中测试没有完整跑完");
  if (!input.failures) return deny("失败日志解析不全");
  if (!input.failures.length) return deny("步骤红了却没有可归属的测试失败");
  const stray = input.failures.find((f) => !TEST_FILE.test(norm(f.file)));
  if (stray) return deny(`失败归属不到测试文件：${stray.file}`);
  if (!input.changed) return deny("读不出 PR 改动");
  const self = input.changed.map(norm).find((p) => SELF.some((re) => re.test(p)));
  if (self) return deny(`PR 改了放行判定本身：${self}`);
  const mine = new Set(r.tests), changed = new Set(input.changed.map(norm));
  const inSel = input.failures.find((f) => mine.has(norm(f.file)));
  if (inSel) return deny(`失败在责任选集里：${norm(inSel.file)}`);
  const inDiff = input.failures.find((f) => changed.has(norm(f.file)));
  if (inDiff) return deny(`失败在 PR 改动里：${norm(inDiff.file)}`);
  const seen = new Set<string>(), outOfScope: SelectedVerdict["outOfScope"] = [];
  for (const f of input.failures) {
    const key = `${norm(f.file)}\0${f.name}`;
    if (!seen.has(key)) { seen.add(key); outOfScope.push({ file: norm(f.file), name: f.name }); }
  }
  return { allow: true, reason: `${outOfScope.length} 条失败都在责任选集与改动之外`, outOfScope };
}

const SUMMARY_LINE = /^\s*(\d+) ([a-z].*?)\s*$/;
/**
 * bun 收尾汇总里 fail 或 error 大于 0：这片的测试步骤红过。成功结束的片里出现它，说明这片是按回执放行的。
 * 只认最后一行「Ran N tests across M files.」紧挨着的上方汇总块（「 N pass / fail / error / skip / expect() calls」…）；
 * 测试自己打的「 1 fail」在汇总之前，不算。没有收尾汇总（没跑测试、零文件片、崩溃）读作没红过。
 */
export function hasBunFailures(log: string): boolean {
  const lines = log.split(/\r?\n/);
  let i = lines.findLastIndex((l) => /^Ran \d+ tests? across \d+ files?\./.test(l));
  if (i < 0) return false;
  for (i--; i >= 0; i--) {
    const m = SUMMARY_LINE.exec(lines[i]!);
    if (!m) return false;
    if (Number(m[1]) > 0 && /^(fail|errors?)$/.test(m[2]!)) return true;
  }
  return false;
}

/**
 * 分片自己存的 shard.log（bun 原样输出）→ parseFailedLog 认的 `gh run view --log-failed` 形状：每行加 `作业\t步骤\t` 前缀
 * （测试自己打的制表符不会被当成步骤边界），Actions 工作流命令 `::group::` / `::endgroup::` / `::error …::` 换成 runner 日志里的 `##[…]`。
 */
export function shardLogFailures(log: string, shard: number): CiFailure[] | null {
  const prefix = `test shard ${shard}\tUnit tests\t`;
  const lines = log.split(/\r?\n/).map((l) => prefix + l.replace(/^::(group|endgroup|error|warning|notice)(?: .*?)?::/, "##[$1]"));
  return parseFailedLog(lines.join("\n"));
}

/** 跑过的测试文件（日志里的 group 行），去掉 ./ 前缀。 */
const ranFiles = (log: string): string[] =>
  [...new Set(log.split(/\r?\n/).flatMap((l) => /^(?:::group::|##\[group\])(.+):$/.exec(l)?.[1] ?? []).map(norm))].sort();

/** 分到的文件都跑到了、没多跑，且 bun 打出了收尾的汇总行；bun 以 1（测试失败）退出。 */
export function shardComplete(log: string, assigned: readonly string[], exitCode: number): boolean {
  if (exitCode !== 1 || !/^Ran \d+ tests? across \d+ files?\./m.test(log)) return false;
  const want = [...new Set(assigned.map(norm))].sort(), got = ranFiles(log);
  return want.length > 0 && JSON.stringify(want) === JSON.stringify(got);
}

export const RECEIPT_VERSION = 1;
/** 一片的回执（工件 ci-selected-shard-<k>）。applied = 这片因它以成功结束（只在 on 且放行时）。 */
export interface ShardReceipt {
  version: typeof RECEIPT_VERSION; kind: "ci-selected-shard"; mode: CiSelectedMode; shard: number;
  runId: number; attempt: number; head: string; planDigest: string; responsibilityDigest: string | null;
  logDigest: string; exitCode: number; allow: boolean; applied: boolean; reason: string; outOfScope: { file: string; name: string }[];
}
export const receiptDigest = (r: unknown): string => sha256(canonicalJson(r));
export const logDigest = (log: string): string => sha256(log);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = ["version", "kind", "mode", "shard", "runId", "attempt", "head", "planDigest", "responsibilityDigest", "logDigest", "exitCode",
  "allow", "applied", "reason", "outOfScope"];

/** 严格读一份回执：字段恰好这些、类型都对；applied 只能出现在 on 且 allow 的回执上。不认识的读作 null。 */
export function parseReceipt(raw: unknown): ShardReceipt | null {
  if (!isObj(raw) || Object.keys(raw).length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every((k) => k in raw)) return null;
  const r = raw as unknown as ShardReceipt;
  if (r.version !== RECEIPT_VERSION || r.kind !== "ci-selected-shard" || !["off", "observe", "on"].includes(r.mode)) return null;
  if (!posInt(r.shard) || !posInt(r.runId) || !posInt(r.attempt) || typeof r.head !== "string" || !SHA.test(r.head)) return null;
  if (typeof r.planDigest !== "string" || !(r.responsibilityDigest === null || DIGEST.test(String(r.responsibilityDigest)))) return null;
  if (!DIGEST.test(String(r.logDigest)) || !Number.isSafeInteger(r.exitCode) || typeof r.reason !== "string") return null;
  if (typeof r.allow !== "boolean" || typeof r.applied !== "boolean" || (r.applied && !(r.allow && r.mode === "on"))) return null;
  if (!Array.isArray(r.outOfScope) || !r.outOfScope.every((f) => isObj(f) && typeof f.file === "string" && typeof f.name === "string")) return null;
  return r;
}

/** 一份放行回执是否属于这次 run / attempt / 检出、这一片、这份日志；返回问题（空 = 对得上）。 */
export function receiptProblems(raw: unknown, want: { shard: number; runId: number; attempt: number; head: string; log: string | undefined }): string[] {
  const name = `ci-selected-shard-${want.shard}`;
  if (raw === undefined) return [`第 ${want.shard} 片走了放行却缺回执 ${name}`];
  const r = parseReceipt(raw);
  if (!r) return [`${name} 不是合法回执（版本 ${RECEIPT_VERSION}）`];
  const out: string[] = [];
  if (r.shard !== want.shard) out.push(`${name} 记的是第 ${r.shard} 片`);
  if (r.runId !== want.runId || r.attempt !== want.attempt) out.push(`${name} 来自 run ${r.runId} attempt ${r.attempt}，不是本次 run ${want.runId} attempt ${want.attempt}`);
  if (r.head.toLowerCase() !== want.head.toLowerCase()) out.push(`${name} 的 head ${r.head.slice(0, 12)} ≠ 本次检出 ${want.head.slice(0, 12)}`);
  if (want.log === undefined || r.logDigest !== logDigest(want.log)) out.push(`${name} 记的日志摘要与这一片的日志不符`);
  if (!r.applied) out.push(`${name} 没有放行（${r.reason}）`);
  return out;
}

/** 证明里的放行一节（ci-proof 的 selected.json）：带版本号，内容的 digest 写进 manifest.policyVersion 的后缀。 */
export const SELECTED_SECTION_VERSION = "ci-selected-1";
export interface SelectedSection {
  version: typeof SELECTED_SECTION_VERSION; runId: number; attempt: number; head: string; responsibilityDigest: string;
  receipts: { shard: number; digest: string; receipt: ShardReceipt }[];
}
export const sectionDigest = (s: SelectedSection): string => sha256(canonicalJson(s));
/** 带放行的证明的 policyVersion：`<规则版本>+ci-selected-1:<一节的 digest>`。 */
export const selectedPolicyVersion = (base: string, digest: string): string => `${base}+${SELECTED_SECTION_VERSION}:${digest}`;

/** 校验端：一节的内容与 manifest 记的 digest、run、attempt、检出一致，每份回执的 digest 与它的内容一致且都放行了。 */
export function sectionProblems(raw: unknown, want: { digest: string; runId: number; attempt: number; head: string }): string[] {
  if (!isObj(raw)) return ["带放行的证明缺放行回执一节"];
  const s = raw as unknown as SelectedSection;
  if (s.version !== SELECTED_SECTION_VERSION || !Array.isArray(s.receipts) || !s.receipts.length) return [`放行一节不是 ${SELECTED_SECTION_VERSION}`];
  const out: string[] = [];
  if (sectionDigest(s) !== want.digest) out.push("放行一节的 digest 与证明记的不符");
  if (s.runId !== want.runId || s.attempt !== want.attempt) out.push(`放行一节来自 run ${s.runId} attempt ${s.attempt}，不是本次`);
  if (typeof s.head !== "string" || s.head.toLowerCase() !== want.head.toLowerCase()) out.push("放行一节的 head 与证明检出不符");
  for (const x of s.receipts) {
    const r = isObj(x) ? parseReceipt(x.receipt) : null;
    if (!r || x.digest !== receiptDigest(r) || x.shard !== r.shard) { out.push(`第 ${isObj(x) ? String(x.shard) : "?"} 片回执 digest 不符`); continue; }
    if (!r.applied || r.runId !== s.runId || r.attempt !== s.attempt || r.head.toLowerCase() !== String(s.head).toLowerCase()
      || r.responsibilityDigest !== s.responsibilityDigest) out.push(`第 ${r.shard} 片回执与放行一节不一致`);
  }
  return out;
}
