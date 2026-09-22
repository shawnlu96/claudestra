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
  "peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-scope", "peer-http-remove",
  "peer-invite-new", "peer-join-auto", "peer-invite-revoke",
  "token-add", "token-revoke",
  "project-add", "project-edit", "project-remove", "project-assign", "project-migrate",
  "pi-env-set",
  // 以下原先漏掉：set-session / set-claude / announce-focus 写 registry；migrate 直写 registry.json；
  // peer-invite-redeem 写 principals + peers；peer-invite-list 顺手清扫过期邀请（吊销 token、写 peers）
  "set-session", "set-claude", "announce-focus", "migrate", "peer-invite-redeem", "peer-invite-list",
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

/** 这次调用会不会改状态（→ 认主守卫 + 命令级写锁） */
export function isWriteInvocation(cmd: string | undefined, args: readonly string[]): boolean {
  if (!cmd) return false;
  if (WRITE_COMMANDS.has(cmd)) return true;
  if (cmd === "takeover") return takeoverWrites(args);
  const sub = args[0] ?? "";
  const subs = WRITE_SUBCOMMANDS[cmd];
  if (subs) return subs.has(sub);
  if (cmd === "auto-update") return !AUTO_UPDATE_READ_SUBS.has(sub);
  return false;
}
