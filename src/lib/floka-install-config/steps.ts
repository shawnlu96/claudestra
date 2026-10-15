/**
 * rename.installConfig 的两个写步骤（floka-migration/transaction 执行器）。日志只记「本迁移加了什么」：
 * allow 记新规则原先在不在；.env 记哪些新名原先就有、旧名值的短指纹（不含值本身）。
 * 回滚每次都重读当前文件，只删本迁移加的、且仍是当时写入值的条目：用户后来改过的、别处加的一律留下。
 * 每步旧值都带 target（本步受管文件解析软链后的真实路径指纹，plan.ts fileTarget）：换了仓库、HOME 或软链改指向别处，
 * 日志里的旧值不能拿去补偿别的文件；写入前也核一遍，读计划之后目标变了就不写。
 */
import { writeTextAtomicSync } from "../state-file.js";
import { readClaudeSettings, writeClaudeSettings } from "../session-recall.js";
import { NEW_FAMILY } from "../floka-mcp/families.js";
import type { Json, TxStep } from "../floka-migration/transaction/types.js";
import { object } from "../floka-config/values.js";
import { allowList, envLines, envPathOf, familyAllow, fileTarget, readText, settingsPathOf, valuePrint, type InstallHome } from "./plan.js";
import { bunLoadedEnv } from "./bun-env.js";

export const INSTALL_CONFIG_ITEM = "rename.installConfig";
export const STEP_IDS = ["install.allow", "install.env"] as const;
const NEW_ALLOW = familyAllow(NEW_FAMILY);

/** 每步的受管文件与它当前的目标身份；run.ts 在续跑 / 重放 / 回滚前按步核对日志 */
export const stepTargets = (h: InstallHome): Record<string, string> =>
  ({ [STEP_IDS[0]]: fileTarget(settingsPathOf(h)), [STEP_IDS[1]]: fileTarget(envPathOf(h)) });

/** 日志里的旧值属于别的目标文件：拒绝补偿 */
function assertTarget(path: string, before: Json): void {
  if (object(before).target !== fileTarget(path)) throw new Error(`事务日志记录的目标文件与当前 ${path} 的实际目标不符，拒绝补偿`);
}
/** 读计划时认定的目标在写之前变了（软链被改指向）：不写 */
function assertUnmoved(path: string, target: string): void {
  if (fileTarget(path) !== target) throw new Error(`${path} 的实际目标在迁移过程中变了，拒绝写入`);
}

function allowStep(h: InstallHome): TxStep<null> {
  const path = settingsPathOf(h), target = fileTarget(path);
  const present = async () => allowList(await readClaudeSettings(path)).includes(NEW_ALLOW);
  return {
    id: STEP_IDS[0], item: INSTALL_CONFIG_ITEM, recovery: "remove only the added new-family allow rule; keep legacy and user rules",
    read: async () => ({ target, hadNew: await present() }),
    conflicts: async () => {
      const allow = object((await readClaudeSettings(path)).permissions).allow;
      return allow === undefined || Array.isArray(allow) ? [] : ["settings.json permissions.allow 不是数组"];
    },
    done: present,
    apply: async () => {
      const s = await readClaudeSettings(path), permissions = object(s.permissions);
      const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
      if (allow.includes(NEW_ALLOW)) return;
      assertUnmoved(path, target);
      await writeClaudeSettings(path, { ...s, permissions: { ...permissions, allow: [...allow, NEW_ALLOW] } });
    },
    verify: present,
    compensate: async (_a, before: Json) => {
      assertTarget(path, before);
      if (object(before).hadNew) return;
      const s = await readClaudeSettings(path), permissions = object(s.permissions);
      if (!allowList(s).includes(NEW_ALLOW)) return;
      await writeClaudeSettings(path, { ...s, permissions: { ...permissions, allow: allowList(s).filter(r => r !== NEW_ALLOW) } });
    },
  };
}

/** 在每个登记的旧名赋值（多行值按完整边界）后面插一条同值新名（原文字节照抄，行尾沿用旧行的 CRLF / LF）；已有新名的不动 */
function withTwins(text: string): string {
  const lines = text.split("\n"), parsed = envLines(text);
  const have = new Set(parsed.filter(l => l.brand === "FLOKA").map(l => l.suffix));
  const add: Array<[number, string]> = [];
  for (const l of parsed) {
    if (l.brand !== "CLAUDESTRA" || have.has(l.suffix)) continue;
    add.push([l.index + l.span, `${l.lead}FLOKA_${l.suffix}=${l.rhs}${l.eol}`]);
    have.add(l.suffix);
  }
  for (const [at, line] of add.reverse()) lines.splice(at, 0, line);
  return lines.join("\n");
}

/**
 * 写之前用真实 Bun 加载复核（bun-env.ts，含 `$` 展开）：原有变量逐个同值、新增的只有新名且与旧名同值。
 * 插新名改变了别的变量的展开结果、旧值自引用复制后不同值、或复核本身跑不起来，都拒绝写入。
 */
function twinProblems(before: string, after: string): string[] {
  if (after === before) return [];
  const was = bunLoadedEnv(before), now = bunLoadedEnv(after);
  if (!was || !now) return [".env 无法用 Bun 复核加载结果，拒绝写入"];
  const added = Object.keys(now).filter(k => !(k in was));
  const out = Object.keys(was).filter(k => now[k] !== was[k]).map(k => `${k} 的加载值会被改变`);
  for (const k of added) {
    const legacy = k.startsWith("FLOKA_") ? `CLAUDESTRA_${k.slice("FLOKA_".length)}` : null;
    if (!legacy || now[k] !== was[legacy]) out.push(`新增的 ${k} 与旧名不同值`);
  }
  return out.map(p => `.env ${p}，无法安全复制，拒绝写入`);
}

function envStep(h: InstallHome): TxStep<null> {
  const path = envPathOf(h), target = fileTarget(path);
  const text = () => readText(path) ?? "";
  const done = async () => withTwins(text()) === text();
  return {
    id: STEP_IDS[1], item: INSTALL_CONFIG_ITEM, recovery: "remove only added FLOKA_ twins whose value is unchanged since migration",
    read: async () => {
      const parsed = envLines(text());
      return {
        target,
        existing: parsed.filter(l => l.brand === "FLOKA").map(l => l.suffix),
        legacy: Object.fromEntries(parsed.filter(l => l.brand === "CLAUDESTRA").map(l => [l.suffix, valuePrint(l.rhs)])),
      };
    },
    conflicts: async () => { const t = text(); return twinProblems(t, withTwins(t)); },
    done,
    apply: async () => {
      const before = text(), after = withTwins(before);
      if (after === before) return;
      const problems = twinProblems(before, after); // 读计划与写之间文件可能被改过：写前再核一次
      if (problems.length) throw new Error(problems.join("；"));
      assertUnmoved(path, target);
      writeTextAtomicSync(path, after, { preserveMode: true });
    },
    verify: done,
    compensate: async (_a, raw: Json) => {
      assertTarget(path, raw);
      const before = object(raw), existing = new Set<unknown>(Array.isArray(before.existing) ? before.existing : []);
      const legacy = object(before.legacy), current = text();
      const drop = new Set(envLines(current).filter(l => l.brand === "FLOKA" && !existing.has(l.suffix)
        && legacy[l.suffix] === valuePrint(l.rhs)).flatMap(l => Array.from({ length: l.span }, (_, k) => l.index + k)));
      if (!drop.size) return;
      writeTextAtomicSync(path, current.split("\n").filter((_, i) => !drop.has(i)).join("\n"), { preserveMode: true });
    },
  };
}

export const installConfigSteps = (h: InstallHome): TxStep<null>[] => [allowStep(h), envStep(h)];
