/**
 * 哪些 manager 调用会改状态 → 要过认主守卫（lib/owner-guard.ts）和命令级写锁（lib/file-lock.ts）。
 *
 * 为什么单独成模块：这张表原来是 manager.ts 里的一个 Set 字面量，跟实际写状态的命令
 * 对不上——set-session / set-claude / takeover / announce-focus / migrate /
 * peer-invite-redeem / peer-invite-list（过期清扫会吊销 token、写 peers），以及
 * permissions/effort/mode/model/auto-update 的写子命令都会写 registry / principals /
 * config，却既不认主也不拿锁；反过来 "clear" 在表里却没有对应的 case。抽成纯函数才能用测试钉住。
 *
 * 读命令（list / sessions / cost / doctor / version / token-list / get …）一律放行：
 * 在备机上查看状态是正当需求，排障时最需要。
 *
 * 所有写调用共用同一把命令级锁（不另起短锁）：bridge 同步 await 的 set-claude /
 * peer-invite-redeem 在 restart-all 持锁期间最多多等 20s 后降级放行，在 runManager
 * 默认 120s 预算之内。彻底消除丢更新要让 restart 等长写路径「持锁期间重新 load 再 save」，
 * 那在生命周期区，不在这里做。
 */

/** 整条命令都是写（不看子命令） */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "create", "resume", "adopt", "kill", "remove", "restart", "rename", "archive",
  "cron-add", "cron-remove", "cron-toggle", "cron-edit",
  "install-hooks",
  "peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-scope", "peer-http-remove", "peer-http-tidy",
  "peer-invite-new", "peer-join-auto", "peer-invite-revoke",
  "token-add", "token-revoke",
  "project-add", "project-edit", "project-remove", "project-assign", "project-merge", "project-migrate", "external", "label",
  "pi-env-set", "team-link", "skill-toggle",
  // 以下原先漏掉：set-session / set-claude / announce-focus 写 registry；migrate 直写 registry.json；
  // peer-invite-redeem 写 principals + peers；peer-invite-list 顺手清扫过期邀请（吊销 token、写 peers）
  "set-session", "set-claude", "announce-focus", "migrate", "peer-invite-redeem", "peer-invite-list",
]);

/**
 * 会写 principals.json 的命令：整条命令另持 principals 锁（lib/principals.ts principalsLockPath），与 bridge 的设备凭据
 * 续期 / 配对 / 撤销（updatePrincipals）互斥——否则 bridge 拿旧副本写回会把 token-revoke / peer 撤销吃掉。
 */
export const PRINCIPALS_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-scope", "peer-http-remove", "peer-http-tidy",
  "peer-invite-new", "peer-join-auto", "peer-invite-revoke", "peer-invite-redeem", "peer-invite-list",
  "token-add", "token-revoke", "external",
]);

/** 读写混合的命令族：只有这些子命令算写（其余 list/get/presets/status 是读） */
const WRITE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  permissions: new Set(["set", "reset"]),
  perm: new Set(["set", "reset"]),
  perms: new Set(["set", "reset"]),
  effort: new Set(["set", "reset", "all"]),
  mode: new Set(["set", "reset", "all"]),
  model: new Set(["set", "reset", "all"]),
  "ctx-boundary": new Set(["on", "off"]),
};

/** ledger 的读子命令；其余都写台账（备机上也要过认主守卫）。meta 只有带 --pms / --docs-dir 才写 */
const LEDGER_READ_SUBS: ReadonlySet<string> = new Set(["", "help", "whoami", "show", "export", "deps", "ask-check"]);
/**
 * ledger 里拿命令级写锁的子命令：task-new / task-set 会写 registry；import 不碰 registry，拿锁只为让一次性迁移与 create / restart 等命令错开，
 * 不影响台账本身的正确性（整批一个 IMMEDIATE 事务）。其余 ledger 写只写 sqlite，不排在 restart 这类长写后面。
 */
const LEDGER_REGISTRY_SUBS: ReadonlySet<string> = new Set(["task-new", "task-set", "import"]);

/** auto-update 的读子命令（缺省即 status）；其余（channel / claudestra on|off / claude on|off）都写 config.json */
const AUTO_UPDATE_READ_SUBS: ReadonlySet<string> = new Set(["", "status", "get"]);

/** takeover 不带目标也不带 --all 时只列候选（读）；带了才会经 cmdResume 建窗口 + 写 registry */
function takeoverWrites(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") return true;
    if (a === "--name") { i++; continue; }
    if (a.startsWith("--")) continue; // --force / --name=x
    return true; // 位置参数 = 目标
  }
  return false;
}

/** 要不要拿命令级写锁：写命令里只有只写台账 sqlite 的 ledger 子命令例外（认主守卫照旧按 isWriteInvocation） */
export function needsWriteLock(cmd: string | undefined, args: readonly string[]): boolean {
  if (cmd === "ledger") return LEDGER_REGISTRY_SUBS.has(args[0] ?? "");
  return isWriteInvocation(cmd, args);
}

/** 这次调用会不会改状态（→ 认主守卫 + 命令级写锁） */
export function isWriteInvocation(cmd: string | undefined, args: readonly string[]): boolean {
  if (!cmd) return false;
  if (WRITE_COMMANDS.has(cmd)) return true;
  if (cmd === "takeover") return takeoverWrites(args);
  if (cmd === "repair") return args.includes("--apply"); // 不带 --apply 只列计划
  const sub = args[0] ?? "";
  if (cmd === "codex-sub-archive") return sub === "on" || sub === "off"; // 写 config.json；status 是读
  const subs = WRITE_SUBCOMMANDS[cmd];
  if (subs) return subs.has(sub);
  if (cmd === "auto-update") return !AUTO_UPDATE_READ_SUBS.has(sub);
  if (cmd === "ledger" && sub === "audit") return !args.includes("--dry-run"); // 巡检默认把结果写进 audit_findings
  if (cmd === "ledger") return sub === "meta" ? args.slice(1).some((a) => /^--(pms|docs-dir)(=|$)/.test(a)) : !LEDGER_READ_SUBS.has(sub);
  return false;
}
