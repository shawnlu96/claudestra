import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_ROOT } from "@/lib/data-root";
import webpush from "web-push";

/**
 * VAPID 密钥对——原生 Web Push 的服务端身份(owner 2026-07-16「做 pwa 推送」,
 * 选型:自托管 VAPID 而非 OneSignal,零第三方注册零外部依赖)。
 * 首次访问自动生成并落盘 ~/.claude-orchestrator/web/push-vapid.json,之后复用
 * ——换密钥会让所有既有订阅失效,所以必须持久化。
 */

const VAPID_FILE = join(DATA_ROOT, "push-vapid.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;
let applied = false;

export function getVapidKeys(): VapidKeys {
  if (cached) return cached;
  if (existsSync(VAPID_FILE)) {
    cached = JSON.parse(readFileSync(VAPID_FILE, "utf8")) as VapidKeys;
  } else {
    cached = webpush.generateVAPIDKeys();
    mkdirSync(DATA_ROOT, { recursive: true });
    writeFileSync(VAPID_FILE, JSON.stringify(cached, null, 2), { mode: 0o600 });
  }
  return cached;
}

/** 给 web-push 应用 VAPID 身份(幂等)。
 *  subject 必须是合法 https URL 或 mailto——Apple 推送服务严格校验,
 *  `.local` 假域名直接 403 BadJwtToken(2026-07-16 真机实测);FCM 不挑。
 *  可用 PUSH_VAPID_SUBJECT 覆盖。 */
export function ensureVapid(): VapidKeys {
  const keys = getVapidKeys();
  if (!applied) {
    const subject = process.env.PUSH_VAPID_SUBJECT || "https://github.com/shawnlu96/claudestra";
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    applied = true;
  }
  return keys;
}
