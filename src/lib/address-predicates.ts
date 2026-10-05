/**
 * 纯地址段谓词：只看字符串，不查网卡、不起进程、不读本机状态。
 * 中心协议（shared-ledger/artifacts/urls.ts）只依赖这里；net-addr.ts / same-host.ts 为旧 import 路径保留 re-export。
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

/** 对端地址是不是回环（控制面闸门 bridge/web-gateway.ts 与 peer 入口 bridge/peer-ingress.ts 共用） */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  // normalize(review nit-c):大写/十六进制压缩形态也归一。miss 方向本就是
  // 误拒不是误放(安全无洞),补齐只为不误伤边角形态。Bun requestIP 规范化
  // 输出下只会是 127.x / ::1 / ::ffff:127.x,后两条是防御性冗余。
  const a = addr.toLowerCase();
  return (
    a === "::1" ||
    a === "::ffff:127.0.0.1" ||
    a === "::ffff:7f00:1" ||
    a === "0:0:0:0:0:ffff:7f00:1" ||
    a.startsWith("127.") ||
    a.startsWith("::ffff:127.")
  );
}
