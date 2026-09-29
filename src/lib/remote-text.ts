/**
 * 对方实例、中继给的错误码与说明（明文 HTTP 错误体、中继 error 帧）会进调用方 agent 的上下文，中继能随意伪造它们：
 * 错误码只认短机器码，认不出就换成调用方给的兜底码；说明只留文字、数字与少量标点（去掉换行、反引号、管道符），截到 200 字。
 * 用在 lib/peer-e2e-client.ts codeOf、lib/relay-client-outbound.ts onError、lib/peer-e2e-redeem.ts readRedeemResponse。
 */
const CODE_RE = /^[a-z0-9_]{1,40}$/;

export const remoteCode = (v: unknown, fallback: string): string => (typeof v === "string" && CODE_RE.test(v) ? v : fallback);

export const remoteDetail = (v: unknown): string => (typeof v === "string" ? v.replace(/[^\p{L}\p{N} .,:;_()'/-]/gu, "").slice(0, 200) : "");
