/**
 * 发往别的实例的任务单先脱敏（docs/team/collab-model.md「派单」）：密钥 / token、内网地址、个人信息换成固定占位符。
 * 纯函数、规则按固定顺序跑，同样的输入逐字得到同样的输出（tests/dispatch-order.test.ts）。
 * 宁可多遮：遮错一段只是对方少看一点，漏遮一枚 token 就收不回来。普通 git sha（7–40 位十六进制）不遮——审查要对 head。
 */

import { redactFields } from "./redact-fields.js";

export const REDACTED = { secret: "[已脱敏:密钥]", addr: "[已脱敏:内网地址]", personal: "[已脱敏:个人信息]" } as const;

type Rule = { re: RegExp; to: string | ((m: string, ...g: string[]) => string) };

const RULES: readonly Rule[] = [
  // 按字段名遮整段值（JSON / YAML / key=value / --flag，跨行也算）在 redact-fields.ts，先跑；这里补字段名之外的写法
  { re: /\b(Bearer\s+)(?!\[已脱敏)[A-Za-z0-9._~+/=-]{8,}/gi, to: (_m, p) => `${p}${REDACTED.secret}` },
  // 常见前缀的密钥
  { re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tok_[A-Za-z0-9]{8,})\b/g, to: REDACTED.secret },
  // PEM 私钥块
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, to: REDACTED.secret },
  // 长串随机值：十六进制 ≥ 48 位（git sha 最长 40 位，不受影响）、base64url ≥ 32 位且大小写字母和数字都有
  { re: /\b[0-9a-f]{48,}\b/gi, to: REDACTED.secret },
  { re: /(?<![\w/.-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{32,}(?![\w/.-])/g, to: REDACTED.secret },
  // 内网地址：Tailscale 100.64/10、10/8、172.16/12、192.168/16、链路本地，以及内部域名
  { re: /\b(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d{1,3}\.\d{1,3}(?::\d{1,5})?\b/g, to: REDACTED.addr },
  { re: /\b(?:fd[0-9a-f]{2}|fe80):[0-9a-f:]{2,}\b/gi, to: REDACTED.addr },
  { re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|local|internal|lan|home\.arpa)\b/gi, to: REDACTED.addr },
  // 个人信息：邮箱、电话、家目录里的用户名
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: REDACTED.personal },
  // 电话只认带国家码或带分隔符的写法、以及 11 位手机号：毫秒时间戳这类纯数字串不能误伤
  { re: /(?<![\w.])(?:\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}|\d{3}[ -]\d{3,4}[ -]\d{4}|1[3-9]\d{9})(?![\w.])/g, to: REDACTED.personal },
  { re: /(\/(?:Users|home)\/)[^/\s'"`]+/g, to: (_m, p) => `${p}${REDACTED.personal}` },
];

/** 脱敏后的正文 + 命中次数（任务单末尾写「本单脱敏 N 处」） */
export function redactForPeer(text: string): { text: string; count: number } {
  const fields = redactFields(text, REDACTED.secret);
  let count = fields.count;
  let out = fields.text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args: unknown[]) => {
      count++;
      return typeof r.to === "string" ? r.to : r.to(args[0] as string, ...(args.slice(1, -2) as string[]));
    });
  }
  return { text: out, count };
}
