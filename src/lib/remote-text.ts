/**
 * 对方实例、中继给的错误码（明文 HTTP 错误体、中继 error 帧）：只认短机器码，认不出就换成调用方给的兜底码。
 * 这是输出卫生，不是防注入的边界——给 agent 的话一律用本机模板（lib/peer-auth-hints.ts peerCallFailureText），
 * 远端写的说明文字不进模板，只进日志。用在 lib/peer-e2e-client.ts codeOf、lib/relay-client-outbound.ts onError。
 */
const CODE_RE = /^[a-z0-9_]{1,40}$/;

export const remoteCode = (v: unknown, fallback: string): string => (typeof v === "string" && CODE_RE.test(v) ? v : fallback);
