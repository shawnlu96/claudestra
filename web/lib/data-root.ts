import { homedir } from "os";
import { join } from "path";

/**
 * Web 端数据目录的唯一定义（2026-09-23 D6-10）。
 *
 * 以前 CLAUDESTRA_DATA_ROOT 有三种互不兼容的读法：db 当它是 web/ 的**父目录**，
 * vapid / push-ack / client-log 当它是 web/ **本身**，apns 当父目录且默认不在 web/ 下，
 * web-config 干脆不认它。一旦设置，SQLite、VAPID、config.json 会散到三个位置。
 * 统一成 SETUP.md 写的口径：**env = web 数据目录本身**，默认 ~/.claude-orchestrator/web。
 * （本机 plist 与 .env.local 都没设过这个变量，默认路径不变。）
 */
export const ORCH_ROOT = join(homedir(), ".claude-orchestrator");

export const DATA_ROOT = process.env.CLAUDESTRA_DATA_ROOT || join(ORCH_ROOT, "web");

/** APNs 的 AuthKey_*.p8 所在目录：不属于 web 数据，位置保持 ~/.claude-orchestrator/apns 不动 */
export const APNS_DIR = process.env.APNS_KEY_DIR || join(ORCH_ROOT, "apns");
