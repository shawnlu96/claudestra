/**
 * 纯地址段谓词：只看字符串，不查网卡、不起进程、不读本机状态。
 * 中心协议（shared-ledger/artifacts/urls.ts）只依赖这里；net-addr.ts 为旧 import 路径保留 re-export。
 * 本模块不得 import 任何东西（tests/cloud-protocol-address-boundary.test.ts 守着）。
 */

/** Tailscale 分配的地址落在 100.64.0.0/10（CGNAT 段） */
export function isTailscaleAddr(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** RFC1918 私网段 */
export function isPrivateAddr(ip: string): boolean {
  if (/^192\.168\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
