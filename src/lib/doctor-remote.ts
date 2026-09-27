/**
 * doctor 的「手机访问」分组：Tailscale / HTTPS 入口 / 证书剩余天数 / serve 冲突 / 明文入口。
 *
 * 为什么要有：2026-09 诊断发现生产 HTTPS 入口的 ts.net 证书只剩 19 天、没有任何续签任务，
 * doctor 却显示「全部正常」。证书一过期，手机上的 PWA / 推送 / 语音 / Passkey 一起断，
 * 而那时人通常不在电脑前。
 *
 * 只读：判定是纯函数（remoteAccessChecks，单测覆盖），I/O 全在 lib/tailscale 的
 * collectRemoteAccess。修复建议里不写死任何主机名 / LaunchAgent label，都从运行时状态来。
 */

import { existsSync, readFileSync } from "fs";
import type { Check } from "./doctor.js";
import { webPortFromStartScript } from "./cli-install.js";
import { checkRelay } from "./doctor-relay.js";
import { certVerdict, collectRemoteAccess, isWildcardBind, workingHttpsEntry, type RemoteAccessReport } from "./tailscale.js";

const G = "手机访问";

export function remoteAccessChecks(r: RemoteAccessReport): Check[] {
  const out: Check[] = [];
  const ts = r.tailscale;

  // 所有入口都以本机 web 在跑为前提 —— 先查它（checkDaemons 只查 bridge / launcher / cron）
  if (!r.webUp) {
    out.push({ group: G, name: "web 服务", status: "warn", detail: `127.0.0.1:${r.webPort} 没有应答 /api/version —— 手机上哪个地址都打不开`,
      fix: "bun src/manager.ts install-cli 重装 daemon，或看 web 日志（launchctl list | grep claudestra）" });
  }

  if (!ts.installed) {
    out.push({ group: G, name: "Tailscale", status: "warn", detail: "没装 —— 手机只能在同一局域网里用，出门就断",
      fix: "重跑 bun run setup 的「手机访问」一步，会引导安装" });
    return out;
  }
  if (!ts.running) {
    out.push({ group: G, name: "Tailscale", status: "warn", detail: `已装但没连上（${ts.backendState || "未运行"}）`,
      fix: "打开 Tailscale 登录；macOS 首次还要在「系统设置」里允许系统扩展与 VPN 配置" });
    return out;
  }
  out.push({ group: G, name: "Tailscale", status: "ok",
    detail: `在线${ts.dnsName ? ` · ${ts.dnsName}` : ""}${ts.httpsEnabled ? "" : " · tailnet 未开 HTTPS 证书"}` });

  const https = r.entries.filter((e) => e.secure);
  const working = workingHttpsEntry(r);
  const wildcard = r.webBind.filter(isWildcardBind);
  if (working) {
    // web 同时听通配地址 = 明文入口也开着。有的人是有意留作备用，所以只写进 detail，不单独告警
    out.push({ group: G, name: "HTTPS 入口", status: "ok",
      detail: `${working.url}（${working.source === "serve" ? "tailscale serve" : "外部反代"}）` +
        (wildcard.length ? `；web 同时监听 ${wildcard.join(" ")}，明文入口也开着` : "") });
  } else if (https.length === 0) {
    out.push({ group: G, name: "HTTPS 入口", status: "warn",
      detail: "没有 —— 明文入口下语音输入、推送、Passkey、完整 PWA 都用不了（浏览器要求安全上下文）",
      fix: ts.httpsEnabled
        ? "重跑 bun run setup 的「手机访问」一步（会先查 443 占用，经你同意再配 tailscale serve）"
        : "先在 Tailscale 管理后台 DNS 页开启 HTTPS Certificates，再重跑 bun run setup" });
  } else {
    // 探测失败给 warn 不给 fail：可能只是一时超时 / 刚部署完版本还没对齐；证书过期由下面的证书项报 fail
    for (const e of https) {
      if (!e.reachable) {
        out.push({ group: G, name: "HTTPS 入口", status: "warn", detail: `${e.url} TLS 握得上但 HTTP 不通（证书无效/过期、反代后端没起，或一时超时）`,
          fix: "先看下面的证书剩余天数；证书没问题就查反代进程和 web daemon" });
      } else if (!e.matchesLocal) {
        out.push({ group: G, name: "HTTPS 入口", status: "warn", detail: `${e.url} 通到的不是本机当前版本的 web（/api/version 对不上）`,
          fix: "反代可能指错了端口，或 web 还是旧进程 —— 对比 curl <入口>/api/version 与本机 127.0.0.1 的输出" });
      }
    }
  }

  for (const e of https) {
    if (e.certDaysLeft === undefined) continue;
    const v = certVerdict(e.certDaysLeft, e.certLifetimeDays);
    const days = Math.floor(e.certDaysLeft);
    out.push({
      group: G,
      name: "证书剩余",
      status: v,
      detail: e.certDaysLeft < 0
        ? `${e.url} 的证书已过期 ${-days} 天`
        : `${e.url} 的证书还剩 ${days} 天${e.certLifetimeDays ? `（寿命 ${e.certLifetimeDays} 天）` : ""}`,
      ...(v === "ok" ? {} : {
        fix: e.source === "serve"
          ? "serve 模式由 tailscaled 自动续签 —— 确认 Tailscale 在线，必要时重启 Tailscale"
          : "外部反代用的是文件证书，要自己续：bun scripts/renew-ts-cert.ts（默认只演练，加 --apply 才替换），替换后重启反代",
      }),
    });
  }

  if (r.servePorts.includes(443) && r.port443Busy) {
    const who = r.others443.length ? r.others443.join("、") : "另一个进程（lsof 看不见，可能是 root 属主）";
    out.push({ group: G, name: "443 冲突", status: "warn",
      detail: `tailscale serve 占了 443，同时 ${who} 也在听 443 —— 经 tailnet 来的 443 流量只会到 serve`,
      fix: "二选一：保留外部反代就把 serve 挪到 8443；或停掉外部反代" });
  }
  return out;
}

/** web 端口的唯一真源是 web/package.json 的 start 脚本（与 install-cli 同一判据）；bridge 端点也用它 */
export function readWebPort(repoRoot: string): number {
  let start: string | undefined;
  try { start = JSON.parse(readFileSync(`${repoRoot}/web/package.json`, "utf-8"))?.scripts?.start; } catch { /* 用默认端口 */ }
  return webPortFromStartScript(start);
}

export async function checkRemoteAccess(repoRoot: string): Promise<Check[]> {
  if (!existsSync(`${repoRoot}/web/.env.local`)) return []; // 没配 web 的实例不出这组
  try {
    const checks = remoteAccessChecks(await collectRemoteAccess(readWebPort(repoRoot)));
    return [...checks, ...(await checkRelay(G))]; // 中继是 Tailscale 之外的另一条出门路（lib/doctor-relay.ts）
  } catch (e) {
    return [{ group: G, name: "探测", status: "warn", detail: `探测失败：${(e as Error).message}` }];
  }
}
