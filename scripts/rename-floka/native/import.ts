/**
 * rename.native 的配置导入与回滚:旧壳导出的配置 → 新壳(新 bundle)的配置文件。
 * 新 bundle 不继承旧 sandbox,所以配置只能这样搬:服务器地址、配对凭据原样带过去;
 * 推送 token 不搬(token 绑 topic,新壳要在新 topic 下重新注册)。旧壳配置永不改写、不删。
 * on 先写迁移记录、再写新壳配置;重复导入同一份是 unchanged。回滚只删本工具写出且之后没被改过的新壳配置。
 * 真机上的导出 / 导入入口另排;这里吃的是导出后的 JSON 文件。
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { writeTextAtomicSync } from "../../../src/lib/state-file.ts";
import { OLD_IDENTITY, PROPOSED_IDENTITY, SANDBOX_NOTE, type NativeMode } from "./identity.ts";

export const SHELL_FORMAT = "floka.native-shell-config";
const IMPORT_ITEM = "rename.native.import";

interface ShellConfig {
  format: typeof SHELL_FORMAT;
  version: 1;
  bundleId: string;
  defaults: Record<string, string>;
  pairing: unknown;
  push: { topic: string; token: string } | null;
  importedFrom?: { bundleId: string; digest: string };
}

interface ImportRecord { version: 1; item: typeof IMPORT_ITEM; oldPath: string; oldDigest: string; newPath: string; newDigest: string }

interface ImportPlan { oldDigest: string; newDigest: string; newState: "absent" | "same" | "different" }

interface ImportResult {
  item: typeof IMPORT_ITEM;
  mode: NativeMode;
  status: "off" | "planned" | "imported" | "unchanged" | "rolled-back" | "blocked";
  writes: number;
  refusals: string[];
  plan?: ImportPlan;
  carried?: string[];
  notCarried?: { what: string; why: string }[];
  oldShell?: { readable: boolean; pushRetained: boolean };
  sandbox: { inherited: false; note: string };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const recordPathOf = (newPath: string) => `${newPath}.floka-import.json`;

function readOrNull(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseShell(text: string, path: string): ShellConfig {
  const c = JSON.parse(text) as ShellConfig;
  if (c?.format !== SHELL_FORMAT || c.version !== 1 || typeof c.defaults !== "object" || c.defaults === null) throw new Error(`${path} 不是认识的壳配置`);
  return c;
}

function result(mode: NativeMode, status: ImportResult["status"], extra: Partial<ImportResult> = {}): ImportResult {
  return { item: IMPORT_ITEM, mode, status, writes: 0, refusals: [], sandbox: { inherited: false, note: SANDBOX_NOTE }, ...extra };
}

/** 由旧壳配置算新壳配置的字节:同一份输入永远得到同一份输出(幂等的基础) */
function buildNewShell(old: ShellConfig, oldDigest: string): string {
  const next: ShellConfig = {
    format: SHELL_FORMAT, version: 1, bundleId: PROPOSED_IDENTITY.ios.bundleId,
    defaults: old.defaults, pairing: old.pairing, push: null,
    importedFrom: { bundleId: old.bundleId, digest: oldDigest },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** stat follows symlinks and compares inode identity, including directory aliases and hard links. */
function recordRefusals(oldPath: string, newPath: string, oldDigest: string, newDigest: string): string[] {
  const recordPath = recordPathOf(newPath);
  const existing = readOrNull(recordPath);
  if (existing === null) {
    try { lstatSync(recordPath); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // No directory entry means there is no record to protect.
      throw e;
    }
    return [`迁移记录 ${recordPath} 是悬空链接,不覆盖`];
  }
  const source = statSync(oldPath);
  const record = statSync(recordPath);
  if (source.dev === record.dev && source.ino === record.ino) return ["迁移记录路径与旧壳配置指向同一个文件,不覆盖"];
  // Only our exact record for this import can be reused; arbitrary JSON or another import is not ownership proof.
  if (existing !== importRecordText(oldPath, newPath, oldDigest, newDigest)) return [`迁移记录 ${recordPath} 已存在且不属于本次导入,不覆盖`];
  return [];
}

function importRecordText(oldPath: string, newPath: string, oldDigest: string, newDigest: string): string {
  const record: ImportRecord = { version: 1, item: IMPORT_ITEM, oldPath, oldDigest, newPath, newDigest };
  return `${JSON.stringify(record, null, 2)}\n`;
}

function compute(oldPath: string, newPath: string): { refusals: string[]; plan?: ImportPlan; text?: string } {
  const oldText = readOrNull(oldPath);
  if (oldText === null) return { refusals: [`旧壳配置 ${oldPath} 不存在`] };
  const old = parseShell(oldText, oldPath);
  if (old.bundleId !== OLD_IDENTITY.ios.bundleId) return { refusals: [`旧壳配置的 bundleId 是 ${old.bundleId},不是 ${OLD_IDENTITY.ios.bundleId}`] };
  const oldDigest = sha(oldText);
  const text = buildNewShell(old, oldDigest);
  const existing = readOrNull(newPath);
  const newState = existing === null ? "absent" : existing === text ? "same" : "different";
  const refusals = newState === "different" ? [`新壳配置 ${newPath} 已存在且不是这份导入的结果,不覆盖`] : [];
  refusals.push(...recordRefusals(oldPath, newPath, oldDigest, sha(text)));
  return { refusals, plan: { oldDigest, newDigest: sha(text), newState }, text };
}

const CARRIED = ["defaults(服务器地址等)原样", "pairing(配对凭据)原样"];
const NOT_CARRIED = [{ what: "push token", why: "token 绑旧 topic;新壳在新 topic 下重新注册,旧壳的推送凭据留在旧壳" }];

export function planImport(opts: { mode: NativeMode; oldPath: string; newPath: string }): ImportResult {
  if (opts.mode === "off") return result("off", "off");
  const c = compute(opts.oldPath, opts.newPath);
  return result(opts.mode, c.refusals.length ? "blocked" : "planned", { refusals: c.refusals, plan: c.plan, carried: CARRIED, notCarried: NOT_CARRIED });
}

export function applyImport(opts: { mode: NativeMode; oldPath: string; newPath: string; plan: ImportResult | ImportPlan | undefined }): ImportResult {
  if (opts.mode !== "on") return planImport(opts);
  const given = opts.plan && "item" in opts.plan ? opts.plan.plan : opts.plan;
  if (!given?.oldDigest) return result("on", "blocked", { refusals: ["on 必须给 observe 出来的计划"] });
  const c = compute(opts.oldPath, opts.newPath);
  if (c.refusals.length || !c.plan || c.text === undefined) return result("on", "blocked", { refusals: c.refusals, plan: c.plan });
  if (c.plan.oldDigest !== given.oldDigest) return result("on", "blocked", { refusals: ["旧壳配置在计划之后变了,重新 observe"], plan: c.plan });
  const recordPath = recordPathOf(opts.newPath);
  const recordText = importRecordText(opts.oldPath, opts.newPath, c.plan.oldDigest, c.plan.newDigest);
  let writes = 0;
  if (readOrNull(recordPath) !== recordText) { writeTextAtomicSync(recordPath, recordText, { mode: 0o600 }); writes++; }
  if (c.plan.newState === "absent") { writeTextAtomicSync(opts.newPath, c.text, { mode: 0o600 }); writes++; }
  const status = c.plan.newState === "same" && writes === 0 ? "unchanged" : "imported";
  return result("on", status, { writes, plan: c.plan, carried: CARRIED, notCarried: NOT_CARRIED });
}

/** 回旧壳:核旧壳配置还在且未变、推送凭据仍在;删本工具写出的新壳配置。旧壳配置一个字节不动 */
export function rollbackImport(opts: { mode: NativeMode; newPath: string }): ImportResult {
  if (opts.mode === "off") return result("off", "off");
  const recordPath = recordPathOf(opts.newPath);
  const recText = readOrNull(recordPath);
  if (recText === null) return result(opts.mode, "unchanged", { refusals: [], oldShell: undefined });
  const rec = JSON.parse(recText) as ImportRecord;
  if (rec?.version !== 1 || rec.item !== IMPORT_ITEM) throw new Error(`迁移记录 ${recordPath} 格式不认识`);
  const oldText = readOrNull(rec.oldPath);
  const old = oldText === null ? null : parseShell(oldText, rec.oldPath);
  const oldShell = { readable: old !== null, pushRetained: !!old?.push?.token };
  const refusals: string[] = [];
  if (oldText === null || sha(oldText) !== rec.oldDigest) refusals.push(`旧壳配置 ${rec.oldPath} 不在或已不是导入时那份,先人工核`);
  const current = readOrNull(rec.newPath);
  if (current !== null && sha(current) !== rec.newDigest) refusals.push(`新壳配置 ${rec.newPath} 导入后被改过,不删`);
  if (refusals.length) return result(opts.mode, "blocked", { refusals, oldShell });
  if (opts.mode === "observe") return result("observe", "planned", { oldShell });
  let writes = 0;
  if (current !== null) { unlinkSync(rec.newPath); writes++; }
  unlinkSync(recordPath);
  return result("on", "rolled-back", { writes: writes + 1, oldShell });
}
