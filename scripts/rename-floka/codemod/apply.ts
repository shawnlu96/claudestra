/**
 * 执行计划（rename.codemod = on）。源目录只读，改写后的文件只写进显式给的临时目标根，别处一个字节都不写。
 * 先全部核完再动笔：计划没被改过、现在重算的计划和它逐字相同（源没变、没多出没人认领的旧名）、获准的规则都是 brand、
 * 目标根在系统临时目录里且写入路径上没有软链。任何一条不满足就抛 Refusal，此时目标根里什么都还没写。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildPlan, planDigest, rewrite, type CodemodMode, type Plan } from "./plan.ts";
import type { RuleSet } from "./rules.ts";
import { installCopies, realOr, Refusal, stateDirs, within, type FsCtx } from "./scan.ts";

export interface ApplyOptions extends Partial<FsCtx> {
  mode: CodemodMode;
  /** 临时目标根：必须显式给、已经存在、在系统临时目录里 */
  target?: string;
  /** 获准执行的规则 id：必须显式给，只能是 brand 规则 */
  approved?: string[];
  /** 哪些目录算系统临时目录（测试注入用），缺省是 os.tmpdir() 和 /tmp */
  tmpRoots?: string[];
}
export interface ApplyResult {
  format: "claudestra.rename-codemod-result";
  digest: string;
  target: string;
  written: string[];
  /** 目标根里已经有一份逐字相同的：重复执行落在这里，不重写 */
  unchanged: string[];
  edits: number;
  /** 计划里有编辑、但这次没获准的规则 */
  notApproved: string[];
}

function checkedTarget(target: string | undefined, root: string, ctx: FsCtx, tmpRoots: string[]): string {
  if (!target) throw new Refusal("target_required", "on 必须用 --target 显式指定临时目标根");
  if (!existsSync(target) || !lstatSync(target).isDirectory()) throw new Refusal("target_missing", `${target} 不是已存在的目录（不代建，软链不算）`);
  const real = realpathSync(target);
  if (!tmpRoots.map(realOr).some((t) => real !== t && within(real, t))) throw new Refusal("target_not_temp", `${target} 不在系统临时目录里`);
  if (within(real, root) || within(root, real)) throw new Refusal("target_overlaps_root", "目标根和扫描根不能互相包含");
  const guarded = [...stateDirs(ctx), ...installCopies(ctx.home)];
  if (guarded.some((d) => within(real, d) || within(d, real))) throw new Refusal("target_protected", "目标根不能碰状态目录和外部安装副本");
  return real;
}

function checkedApproval(approved: string[] | undefined, set: RuleSet): Set<string> {
  if (!approved?.length) throw new Refusal("rules_required", "on 必须用 --rules 显式列出获准的规则 id");
  for (const id of approved) {
    const rule = set.rules.find((r) => r.id === id);
    if (!rule) throw new Refusal("rule_unknown", `${id} 不在规则表里`);
    if (rule.class !== "brand") throw new Refusal("rule_not_executable", `${id} 是 ${rule.class} 规则，只有 brand 规则能执行`);
  }
  return new Set(approved);
}

const safeRel = (rel: unknown): rel is string =>
  typeof rel === "string" && rel !== "" && !isAbsolute(rel) && !/[\\\0]/.test(rel) && !rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..");

/** 交上来的计划是外部输入：路径不许出根，digest 要和内容对得上，还要和现在重算的一致 */
function checkedPlan(given: Plan, fresh: Plan) {
  if (given?.format !== "claudestra.rename-codemod-plan" || given.version !== 1 || !Array.isArray(given.files)) throw new Refusal("plan_invalid", "不是 v1 的计划");
  const bad = given.files.find((f) => !safeRel(f?.file));
  if (bad) throw new Refusal("path_escape", `计划里的路径 ${String(bad?.file)} 不是扫描根内的相对路径`);
  if (planDigest(given) !== given.digest) throw new Refusal("plan_tampered", "计划内容和它的 digest 对不上");
  if (fresh.rejections.length) {
    const r = fresh.rejections[0]!;
    throw new Refusal(r.kind, `${r.file}:${r.line} ${r.detail}（共 ${fresh.rejections.length} 条拒绝）`);
  }
  if (fresh.digest === given.digest) return;
  if (fresh.rulesDigest !== given.rulesDigest) throw new Refusal("rules_changed", "规则表和生成计划时不一样，重新生成计划");
  const then = new Map(given.files.map((f) => [f.file, f.sha256]));
  const now = new Map(fresh.files.map((f) => [f.file, f.sha256]));
  const changed = [...new Set([...then.keys(), ...now.keys()])].filter((f) => then.get(f) !== now.get(f)).sort();
  throw new Refusal("source_changed", `生成计划之后源变了：${changed.slice(0, 5).join("、") || "分类结果不同"}`);
}

/** 目标根里这个相对路径现在能不能写：已有的每一级都必须是真目录（不是软链），已有的文件必须是普通文件 */
function targetState(target: string, rel: string): "absent" | "file" {
  const segs = rel.split("/");
  let at = target;
  for (const [i, seg] of segs.entries()) {
    at = join(at, seg);
    const st = lstatSync(at, { throwIfNoEntry: false }); // lstat：悬空软链也算「已有」，下面按软链拒绝
    if (!st) return "absent";
    const last = i === segs.length - 1;
    if (st.isSymbolicLink() || (last ? !st.isFile() : !st.isDirectory())) throw new Refusal("target_escape", `目标根里的 ${segs.slice(0, i + 1).join("/")} 是软链或类型不对`);
  }
  return "file";
}

interface Output { rel: string; body: string; edits: number }

/** 把获准的编辑落到文本上。源文件此刻再读一次：不是普通文件、哈希或编辑处的原文对不上都拒绝 */
function render(root: string, plan: Plan, approved: Set<string>): Output[] {
  const outputs: Output[] = [];
  for (const f of plan.files) {
    const edits = f.edits.filter((e) => approved.has(e.rule));
    if (!edits.length) continue;
    const abs = join(root, f.file);
    if (!safeRel(f.file) || !lstatSync(abs).isFile() || !within(realpathSync(abs), root)) throw new Refusal("path_escape", `${f.file} 不是扫描根内的普通文件`);
    const buf = readFileSync(abs);
    if (createHash("sha256").update(buf).digest("hex") !== f.sha256) throw new Refusal("source_changed", `${f.file} 的哈希和计划不一致`);
    const text = buf.toString("utf8");
    if (edits.some((e) => text.slice(e.start, e.end) !== e.old)) throw new Refusal("source_changed", `${f.file} 编辑处的原文和计划不一致`);
    outputs.push({ rel: f.file, body: rewrite(text, edits), edits: edits.length });
  }
  return outputs;
}

/**
 * 执行。plan 是先前 observe 出来、人看过的那一份；真正落笔用的是此刻重算的计划（两者 digest 相同才走到这一步）。
 * 目标根里已有同名文件：逐字相同就跳过，不同就拒绝——不覆盖别的计划留下的产物。
 */
export function executePlan(root: string, plan: Plan, set: RuleSet, opts: ApplyOptions): ApplyResult {
  if (opts.mode !== "on") throw new Refusal("mode_not_on", `rename.codemod = ${opts.mode}，不执行`);
  const ctx: FsCtx = { env: opts.env ?? process.env, home: opts.home ?? homedir() };
  const approved = checkedApproval(opts.approved, set);
  const fresh = buildPlan(root, set, { ...ctx, mode: "on" });
  const realRoot = realpathSync(root);
  const target = checkedTarget(opts.target, realRoot, ctx, opts.tmpRoots ?? [tmpdir(), "/tmp"]);
  checkedPlan(plan, fresh);
  const outputs = render(realRoot, fresh, approved);
  const pending = outputs.filter((o) => {
    if (targetState(target, o.rel) === "absent") return true;
    if (readFileSync(join(target, o.rel), "utf8") !== o.body) throw new Refusal("target_conflict", `目标根里已有内容不同的 ${o.rel}，换一个空的临时目录`);
    return false;
  });
  for (const o of pending) {
    const dir = o.rel.split("/").slice(0, -1).join("/");
    if (dir) mkdirSync(join(target, dir), { recursive: true });
    // 建完目录再核一遍整条路径，然后只用 wx 新建：中途被换成软链或抢先建了文件都写不出去
    if (targetState(target, o.rel) !== "absent" || !within(realpathSync(join(target, dir)), target)) throw new Refusal("target_escape", `${o.rel} 的写入路径变了`);
    writeFileSync(join(target, o.rel), o.body, { flag: "wx" });
  }
  const planned = new Set(fresh.files.flatMap((f) => f.edits.map((e) => e.rule)));
  return {
    format: "claudestra.rename-codemod-result",
    digest: fresh.digest,
    target,
    written: pending.map((o) => o.rel),
    unchanged: outputs.filter((o) => !pending.includes(o)).map((o) => o.rel),
    edits: outputs.reduce((n, o) => n + o.edits, 0),
    notApproved: [...planned].filter((id) => !approved.has(id)).sort(),
  };
}
