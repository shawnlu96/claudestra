/**
 * rename.installConfig 的两个写步骤（floka-migration/transaction 执行器）。日志只记「本迁移加了什么」：
 * allow 记新规则原先在不在；.env 记哪些新名原先就有、旧名值的短指纹（不含值本身）。
 * 回滚每次都重读当前文件，只删本迁移加的、且仍是当时写入值的条目：用户后来改过的、别处加的一律留下。
 * 每步旧值都带 target（settings / .env 路径的指纹）：换了仓库或 HOME，日志里的旧值不能拿去补偿别的文件。
 */
import { writeTextAtomicSync } from "../state-file.js";
import { parseDotenv } from "../env-file.js";
import { readClaudeSettings, writeClaudeSettings } from "../session-recall.js";
import { NEW_FAMILY } from "../floka-mcp/families.js";
import type { Json, TxStep } from "../floka-migration/transaction/types.js";
import { object } from "../floka-config/values.js";
import { allowList, envLines, envPathOf, familyAllow, installTarget, readText, settingsPathOf, valuePrint, type InstallHome } from "./plan.js";

export const INSTALL_CONFIG_ITEM = "rename.installConfig";
export const STEP_IDS = ["install.allow", "install.env"] as const;
const NEW_ALLOW = familyAllow(NEW_FAMILY);

/** 日志里的旧值属于别的目标文件：拒绝补偿（run.ts 在续跑 / 回滚前也先核一遍） */
function assertTarget(h: InstallHome, before: Json): void {
  if (object(before).target !== installTarget(h)) throw new Error("事务日志记录的目标文件与当前 settings / .env 不符，拒绝补偿");
}

function allowStep(h: InstallHome): TxStep<null> {
  const path = settingsPathOf(h);
  const present = async () => allowList(await readClaudeSettings(path)).includes(NEW_ALLOW);
  return {
    id: STEP_IDS[0], item: INSTALL_CONFIG_ITEM, recovery: "remove only the added new-family allow rule; keep legacy and user rules",
    read: async () => ({ target: installTarget(h), hadNew: await present() }),
    conflicts: async () => {
      const allow = object((await readClaudeSettings(path)).permissions).allow;
      return allow === undefined || Array.isArray(allow) ? [] : ["settings.json permissions.allow 不是数组"];
    },
    done: present,
    apply: async () => {
      const s = await readClaudeSettings(path), permissions = object(s.permissions);
      const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
      if (allow.includes(NEW_ALLOW)) return;
      await writeClaudeSettings(path, { ...s, permissions: { ...permissions, allow: [...allow, NEW_ALLOW] } });
    },
    verify: present,
    compensate: async (_a, before: Json) => {
      assertTarget(h, before);
      if (object(before).hadNew) return;
      const s = await readClaudeSettings(path), permissions = object(s.permissions);
      if (!allowList(s).includes(NEW_ALLOW)) return;
      await writeClaudeSettings(path, { ...s, permissions: { ...permissions, allow: allowList(s).filter(r => r !== NEW_ALLOW) } });
    },
  };
}

/** 在每个登记的旧名赋值（多行值按完整边界）后面插一条同值新名；已有新名（同值或用户自定义）的不动 */
function withTwins(text: string): string {
  const lines = text.split("\n"), parsed = envLines(text);
  const have = new Set(parsed.filter(l => l.brand === "FLOKA").map(l => l.suffix));
  const add: Array<[number, string]> = [];
  for (const l of parsed) {
    if (l.brand !== "CLAUDESTRA" || have.has(l.suffix)) continue;
    add.push([l.index + l.span, `${l.lead}FLOKA_${l.suffix}=${l.rhs}`]);
    have.add(l.suffix);
  }
  for (const [at, line] of add.reverse()) lines.splice(at, 0, line);
  return lines.join("\n");
}

/** 写之前按 Bun 口径复核：原有变量逐个同值、新增的新名与旧名同值；对不上就是解析不了的写法，拒绝写入 */
function twinProblems(before: string, after: string): string[] {
  const was = parseDotenv(before), now = parseDotenv(after);
  const added = Object.keys(now).filter(k => !(k in was));
  const out = Object.keys(was).filter(k => now[k] !== was[k]).map(k => `${k} 的值会被改变`);
  for (const k of added) {
    const legacy = k.startsWith("FLOKA_") ? `CLAUDESTRA_${k.slice("FLOKA_".length)}` : null;
    if (!legacy || now[k] !== was[legacy]) out.push(`新增的 ${k} 与旧名不同值`);
  }
  return out.map(p => `.env ${p}，无法安全复制，拒绝写入`);
}

function envStep(h: InstallHome): TxStep<null> {
  const path = envPathOf(h);
  const text = () => readText(path) ?? "";
  const done = async () => withTwins(text()) === text();
  return {
    id: STEP_IDS[1], item: INSTALL_CONFIG_ITEM, recovery: "remove only added FLOKA_ twins whose value is unchanged since migration",
    read: async () => {
      const parsed = envLines(text());
      return {
        target: installTarget(h),
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
      writeTextAtomicSync(path, after, { preserveMode: true });
    },
    verify: done,
    compensate: async (_a, raw: Json) => {
      assertTarget(h, raw);
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
