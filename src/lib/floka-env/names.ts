/**
 * 改名的环境变量族（docs/migrations/floka.md 的 env.*）：旧名 `CLAUDESTRA_<名>`、新名 `FLOKA_<同名>`。
 * 只登记本卡接入的族；无品牌的 BRIDGE_* / MCP_NAME / RELAY_* / DISCORD_* 不属于这一族，也不生出 FLOKA_ 同义名。
 * ⚠️ 本目录只许依赖 node: 内置模块（lib/state-dir.ts 要在 Pi 的 Node/Jiti 里加载它）。
 */
export const LEGACY_PREFIX = "CLAUDESTRA_";
const FLOKA_PREFIX = "FLOKA_";

/** 后缀（去掉前缀的部分）按族分组 */
export const ENV_FAMILIES = {
  "state-runtime": ["STATE_DIR", "RUNTIME_DIR", "DATA_ROOT"],
  "acp-pi-codex": [
    "ACP_AGENT", "ACP_CLEAN_ENV", "ACP_CLEAR_PREAMBLE", "ACP_CONTROL", "ACP_DEVELOPER", "ACP_EFFORT", "ACP_MODEL", "ACP_RUNTIME",
    "ACP_TREE", "ACP_TUI", "CODEX_BIN", "CODEX_PREAMBLE", "PI_ACTIVATE", "PI_ARGS", "PI_MCP_SERVERS",
  ],
  caller: ["CALLER_CRED_FILE"],
  profile: ["MCP_PROFILE"],
  "agent-session": ["AGENT", "SESSION_ID", "RUNTIME", "TAKEOVER"],
  "sandbox-lab": [
    "SANDBOX", "SANDBOX_ROOT", "SANDBOX_DENY_PORTS", "SANDBOX_DENY_DIRS", "SANDBOX_LAB", "SANDBOX_PORT", "SANDBOX_PARENT_PID",
    "LAB_ROOT", "LAB_PORTS", "LAB_RELAY_PORT", "LAB_PUSH_PORT", "LAB_APNS_PORT",
  ],
  "scheduler-lend": ["SCHEDULER_SERVICE", "SCHEDULER_LEASE", "LEND_WORKER", "LEND_ORDER", "AUTO_SHARE_PASS_LOCK", "MERGE_SHA"],
  "deploy-lock": ["PM_DEPLOY_LOCK_TOKEN"],
  test: ["TEST", "TEST_DEFAULT_LEND_JOURNAL", "TEST_ISOLATED_STATE", "TEST_RUNNER", "TEST_RUNNER_REAL_HOME", "TEST_RUNNER_TMP_ROOT"],
} as const satisfies Record<string, readonly string[]>;

export const RENAMED_SUFFIXES: readonly string[] = Object.values(ENV_FAMILIES).flat();

/**
 * 隔离用的安全变量（沙箱 / lab / 测试两族）：不看改名档位，两套名字都认，两边都设了且不同就拒绝（lib/sandbox.ts、lib/test-guard.ts）。
 * 状态 / 运行目录只在沙箱与测试进程里按隔离变量核（ISOLATED_DIRS；生产照档位解析）。
 */
export const ISOLATION_SUFFIXES: readonly string[] = [...ENV_FAMILIES["sandbox-lab"], ...ENV_FAMILIES.test];
export const ISOLATED_DIRS = ["STATE_DIR", "RUNTIME_DIR"] as const;

/**
 * 无品牌变量（BRIDGE_URL、MCP_NAME、RELAY_URL、DISCORD_* …）的词根：登记的后缀不许以它们开头（不新增它们的 FLOKA_ 同义名）。
 * 只看开头：LAB_RELAY_PORT 本来就是 CLAUDESTRA_ 族（lab 中继端口），要登记。
 */
export const UNBRANDED_STEMS = /^(?:BRIDGE|MCP_NAME|RELAY|DISCORD)(?:_|$)/;

export const legacyName = (suffix: string): string => LEGACY_PREFIX + suffix;
export const flokaName = (suffix: string): string => FLOKA_PREFIX + suffix;

/** `CLAUDESTRA_X` → `X`；不是旧前缀抛错（调用方传常量，传错是代码 bug） */
export function suffixOf(legacy: string): string {
  if (!legacy.startsWith(LEGACY_PREFIX)) throw new Error(`${legacy} 不是 ${LEGACY_PREFIX} 族`);
  return legacy.slice(LEGACY_PREFIX.length);
}
