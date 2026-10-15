/**
 * rename.installConfig 的两个写步骤（floka-migration/transaction 执行器）。日志只记「本迁移加了什么」：
 * allow 记新规则原先在不在；.env 记哪些新名原先就有、旧名值的短指纹（不含值本身）。
 * 回滚每次都重读当前文件，只删本迁移加的、且仍是当时写入值的条目：用户后来改过的、别处加的一律留下。
 */
import { writeTextAtomicSync } from "../state-file.js";
import { readClaudeSettings, writeClaudeSettings } from "../session-recall.js";
import { NEW_FAMILY } from "../floka-mcp/families.js";
import type { Json, TxStep } from "../floka-migration/transaction/types.js";
import { object } from "../floka-config/values.js";
import { allowList, envLines, envPathOf, familyAllow, readText, settingsPathOf, valuePrint, type InstallHome } from "./plan.js";

export const INSTALL_CONFIG_ITEM = "rename.installConfig";
export const STEP_IDS = ["install.allow", "install.env"] as const;
const NEW_ALLOW = familyAllow(NEW_FAMILY);

function allowStep(h: InstallHome): TxStep<null> {
  const path = settingsPathOf(h);
  const present = async () => allowList(await readClaudeSettings(path)).includes(NEW_ALLOW);
  return {
    id: STEP_IDS[0], item: INSTALL_CONFIG_ITEM, recovery: "remove only the added new-family allow rule; keep legacy and user rules",
    read: async () => ({ hadNew: await present() }),
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
      if (object(before).hadNew) return;
      const s = await readClaudeSettings(path), permissions = object(s.permissions);
      if (!allowList(s).includes(NEW_ALLOW)) return;
      await writeClaudeSettings(path, { ...s, permissions: { ...permissions, allow: allowList(s).filter(r => r !== NEW_ALLOW) } });
    },
  };
}

/** 在每个登记的旧名下面插一行同值新名；已有新名（同值或用户自定义）的不动 */
function withTwins(text: string): string {
  const lines = text.split("\n"), parsed = envLines(text);
  const have = new Set(parsed.filter(l => l.brand === "FLOKA").map(l => l.suffix));
  for (const l of [...parsed].reverse()) {
    if (l.brand !== "CLAUDESTRA" || have.has(l.suffix)) continue;
    lines.splice(l.index + 1, 0, `${l.lead}FLOKA_${l.suffix}=${l.rhs}`);
    have.add(l.suffix);
  }
  return lines.join("\n");
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
        existing: parsed.filter(l => l.brand === "FLOKA").map(l => l.suffix),
        legacy: Object.fromEntries(parsed.filter(l => l.brand === "CLAUDESTRA").map(l => [l.suffix, valuePrint(l.rhs)])),
      };
    },
    done,
    apply: async () => {
      const before = text(), after = withTwins(before);
      if (after !== before) writeTextAtomicSync(path, after, { preserveMode: true });
    },
    verify: done,
    compensate: async (_a, raw: Json) => {
      const before = object(raw), existing = new Set<unknown>(Array.isArray(before.existing) ? before.existing : []);
      const legacy = object(before.legacy), current = text();
      const drop = new Set(envLines(current).filter(l => l.brand === "FLOKA" && !existing.has(l.suffix)
        && legacy[l.suffix] === valuePrint(l.rhs)).map(l => l.index));
      if (!drop.size) return;
      writeTextAtomicSync(path, current.split("\n").filter((_, i) => !drop.has(i)).join("\n"), { preserveMode: true });
    },
  };
}

export const installConfigSteps = (h: InstallHome): TxStep<null>[] => [allowStep(h), envStep(h)];
