/**
 * 全新机器上只有 ~/.floka（新品牌安装或用户自建）、没有旧根时，defaultStateRoot 拒绝解析，产品起不来。
 * 安装流程在任何进程加载 lib/paths.ts 之前跑这一步，明确选一个根，之后 defaultStateRoot 不再拒绝：
 *   floka  旧根建成指向 ~/.floka 的软链（与 STATE1 提交后的别名同形）；~/.floka 没有身份就在那里生成。
 *          rename.state 没切 on 时 defaultStateRoot 返回软链路径，数据落在 ~/.floka。
 *   legacy 建空旧根并在旧根生成身份；~/.floka 原样不动。~/.floka 已有身份时拒绝（两个身份会被判冲突）。
 * 只依赖 node: 内置与 key-file（不经 paths.ts：那里加载期就会因为这种情形抛错）。tests/floka-install-config.test.ts。
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStateRoot, maintenanceBarrierPresent } from "../floka-config/default-root.ts";
import { readOrCreateKeyFile } from "../key-file.ts";
import { stateDirIn } from "../state-dir.ts";
import { maintenanceRoot } from "../state-maintenance/paths.ts";

export type FreshRootChoice = "legacy" | "floka";
export type FreshRootResult =
  | { status: "not-fresh"; root: string }
  | { status: "chosen"; choice: FreshRootChoice; root: string }
  | { status: "refused"; error: string };

const kind = (path: string): "missing" | "dir" | "link" | "other" => {
  try {
    const s = lstatSync(path);
    return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "other";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
};

/** 与 lib/instance-id.ts、lib/instance-key.ts 同一份文件格式；同一把 link 原子写，并发首装只留一份 */
function ensureIdentity(root: string, maint: string): void {
  readOrCreateKeyFile(join(root, "instance-id"), () => `${randomBytes(12).toString("hex")}\n`, maint);
  readOrCreateKeyFile(join(root, "instance-key.pem"),
    () => String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" })), maint);
}

/** ~/.floka 有没有可用的身份：两个文件都在才算（内容校验交给 defaultStateRoot 复核） */
const hasIdentity = (root: string): boolean => ["instance-id", "instance-key.pem"].every(n => kind(join(root, n)) !== "missing");

/** 缺省选择：~/.floka 已有身份就沿用它，否则留在旧根、不往用户的目录里写东西 */
const defaultFreshChoice = (home: string): FreshRootChoice => hasIdentity(join(home, ".floka")) ? "floka" : "legacy";

export function chooseFreshStateRoot(home: string, choice: FreshRootChoice = defaultFreshChoice(home)): FreshRootResult {
  const oldRoot = stateDirIn(home), next = join(home, ".floka");
  const maint = maintenanceRoot(home);
  if (kind(oldRoot) !== "missing" || kind(next) !== "dir" || maintenanceBarrierPresent(home)) {
    try { return { status: "not-fresh", root: defaultStateRoot(home, oldRoot) }; } catch (e) {
      return { status: "refused", error: (e as Error).message }; // 不是全新机器的拒绝（迁移中断等）不归本步处理
    }
  }
  if (choice === "legacy" && hasIdentity(next)) return { status: "refused", error: "~/.floka 已有实例身份，选旧根会造成身份冲突；改选 floka" };
  if (choice === "floka") {
    ensureIdentity(next, maint);
    symlinkSync(next, oldRoot);
  } else {
    mkdirSync(oldRoot, { mode: 0o700 });
    ensureIdentity(oldRoot, maint);
  }
  return { status: "chosen", choice, root: defaultStateRoot(home, oldRoot) };
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (arg !== undefined && arg !== "legacy" && arg !== "floka") {
    console.error("用法: fresh-root.ts [legacy|floka]");
    process.exit(2);
  }
  const r = chooseFreshStateRoot(homedir(), arg as FreshRootChoice | undefined);
  console.log(JSON.stringify(r));
  process.exit(r.status === "refused" ? 1 : 0);
}
