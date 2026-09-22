/**
 * 哪些 manager 调用会改状态 → 要过认主守卫（lib/owner-guard.ts）和命令级写锁（lib/file-lock.ts）。
 *
 * 为什么单独成模块：这张表原来是 manager.ts 里的一个 Set 字面量，跟实际写状态的命令
 * 对不上——set-session / set-claude / takeover / announce-focus / migrate /
 * peer-invite-redeem，以及 permissions/effort/mode/model/auto-update 的写子命令都会
 * saveRegistry / 写 principals / 写 config，却既不认主也不拿锁；反过来 "clear" 在表里
 * 却没有对应的 case。抽成纯函数才能用测试钉住。
 *
 * 读命令（list / sessions / cost / doctor / version / *-list / get …）一律放行：
 * 在备机上查看状态是正当需求，排障时最需要。
 */

/** 整条命令都是写（不看子命令） */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "create", "resume", "adopt", "kill", "remove", "restart", "rename", "archive",
  "cron-add", "cron-remove", "cron-toggle", "cron-edit",
  "install-hooks",
  "peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-scope", "peer-http-remove",
  "peer-invite-new", "peer-join-auto", "peer-invite-revoke", "peer-invite-redeem",
  "token-add", "token-revoke",
  "project-add", "project-edit", "project-remove", "project-assign", "project-migrate",
  "pi-env-set",
  // 以下原先漏掉：都会写 registry（takeover 经 cmdResume 建窗口+写 registry；migrate 直写 registry.json）
  "takeover", "set-session", "set-claude", "announce-focus", "migrate",
]);

/** 读写混合的命令族：只有这些子命令算写（其余 list/get/presets/status 是读） */
const WRITE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  permissions: new Set(["set", "reset"]),
  perm: new Set(["set", "reset"]),
  perms: new Set(["set", "reset"]),
  effort: new Set(["set", "reset", "all"]),
  mode: new Set(["set", "reset", "all"]),
  model: new Set(["set", "reset", "all"]),
};

/** auto-update 的读子命令（缺省即 status）；其余（channel / claudestra on|off / claude on|off）都写 config.json */
const AUTO_UPDATE_READ_SUBS: ReadonlySet<string> = new Set(["", "status", "get"]);

/**
 * 不拿命令级写锁、只认主的写命令。
 *
 * set-claude 被 web 设置页同步 await（api-routes 的 claude-settings）；命令级锁在
 * restart / restart-all 期间会被占几分钟，拿锁要空等 20s 才降级放行，等于把设置页
 * 卡 20s 而竞态照旧。它的 load→mutate→save 很短，正解是只包住 RMW 的短锁
 * （updateRegistry），那要改生命周期区的 case，留给后续批次。
 */
const LOCK_EXEMPT: ReadonlySet<string> = new Set(["set-claude"]);

/** 这次调用会不会改状态（→ 认主守卫） */
export function isWriteInvocation(cmd: string | undefined, args: readonly string[]): boolean {
  if (!cmd) return false;
  if (WRITE_COMMANDS.has(cmd)) return true;
  const sub = args[0] ?? "";
  const subs = WRITE_SUBCOMMANDS[cmd];
  if (subs) return subs.has(sub);
  if (cmd === "auto-update") return !AUTO_UPDATE_READ_SUBS.has(sub);
  return false;
}

/** 这次调用要不要拿命令级写锁 */
export function needsWriteLock(cmd: string | undefined, args: readonly string[]): boolean {
  return isWriteInvocation(cmd, args) && !LOCK_EXEMPT.has(cmd!);
}
