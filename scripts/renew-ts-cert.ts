#!/usr/bin/env bun
/**
 * 续签「文件证书」模式的 ts.net 证书（外部反代如 Caddy 用 `tls <crt> <key>` 读静态文件时）。
 *
 * 为什么需要：tailscale serve 模式由 tailscaled 自动续签，但把 `tailscale cert` 签出的文件交给
 * 外部反代时，没有任何东西会去续它 —— 90 天一到入口整个断掉（2026-09 诊断：生产入口只剩 19 天，
 * 旧的 Bun 代理里有续签逻辑，换成 Caddy 后丢了）。
 *
 * **默认只演练（dry-run）**：打印会做什么，不动任何文件。加 --apply 才真的签发并替换。
 * 流程照抄 Oppi：签到临时文件 → 校验 SAN / 有效期 / 私钥配对 → 备份旧文件 → 原子替换；
 * 任何一步失败都保留旧证书。替换后反代要重启/重载才会读新文件 —— 本脚本不替你重启
 * （那是机器级动作，用哪个 label、要不要定时跑，由使用者决定）。
 *
 * 用法:
 *   bun scripts/renew-ts-cert.ts [--cert <path>] [--key <path>] [--host <ts.net 名>]
 *                                [--min-days 30] [--force] [--apply]
 * 默认路径 ~/.claude-orchestrator/web/tls/mac.{crt,key}（web/SETUP.md 的手工方案用的位置）；
 * --host 缺省取 `tailscale status --json` 的 Self.DNSName。
 */

import { X509Certificate, createPrivateKey } from "crypto";
import { existsSync, readFileSync, renameSync, copyFileSync, unlinkSync, chmodSync } from "fs";
import { dirname, basename } from "path";
import { findTailscaleCli, readTailscaleStatus, validateCertCandidate } from "../src/lib/tailscale";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const HOME = process.env.HOME || "";
const CERT = arg("cert") || `${HOME}/.claude-orchestrator/web/tls/mac.crt`;
const KEY = arg("key") || `${HOME}/.claude-orchestrator/web/tls/mac.key`;
const MIN_DAYS = Number(arg("min-days") || 30);
const APPLY = has("apply");
const FORCE = has("force");

function inspect(certPath: string, keyPath: string) {
  const cert = new X509Certificate(readFileSync(certPath));
  let keyMatches = false;
  try { keyMatches = cert.checkPrivateKey(createPrivateKey(readFileSync(keyPath))); } catch { /* 视为不配对 */ }
  return { subjectAltName: cert.subjectAltName || "", validTo: cert.validTo, keyMatches };
}

async function main(): Promise<number> {
  const cli = await findTailscaleCli();
  if (!cli) { console.error("✗ 找不到 tailscale CLI（PATH / App 包内 / brew 位置都没有）"); return 1; }
  const host = arg("host") || (await readTailscaleStatus(cli))?.dnsName || "";
  if (!host) { console.error("✗ 拿不到 ts.net 主机名：Tailscale 没登录或 MagicDNS 没开；也可用 --host 显式给"); return 1; }

  if (existsSync(CERT)) {
    const cur = inspect(CERT, KEY);
    const daysLeft = (Date.parse(cur.validTo) - Date.now()) / 86_400_000;
    console.log(`当前证书: ${CERT}\n  有效期至 ${cur.validTo}（剩 ${Math.floor(daysLeft)} 天）`);
    if (daysLeft >= MIN_DAYS && !FORCE) {
      console.log(`  剩余 ≥ ${MIN_DAYS} 天，不需要续（--force 可强制）`);
      return 0;
    }
  } else {
    console.log(`当前证书不存在: ${CERT}（将新建）`);
  }

  const dir = dirname(CERT);
  const tmpCert = `${dir}/.${basename(CERT)}.new`;
  const tmpKey = `${dir}/.${basename(KEY)}.new`;
  const cmd = [cli, "cert", "--cert-file", tmpCert, "--key-file", tmpKey, "--min-validity", "720h", host];
  if (!APPLY) {
    console.log("\n[演练] 将执行:");
    console.log("  " + cmd.map((s) => (/\s/.test(s) ? `'${s}'` : s)).join(" "));
    console.log(`  校验 SAN 含 ${host}、有效期 ≥ ${MIN_DAYS} 天、私钥配对 → 备份为 *.bak → 原子替换 ${CERT} / ${KEY}`);
    console.log("  之后需重启/重载你的反代让它读新证书。加 --apply 真正执行。");
    return 0;
  }

  const cleanup = () => { for (const f of [tmpCert, tmpKey]) try { unlinkSync(f); } catch { /* 不存在 */ } };
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    cleanup();
    console.error(`✗ tailscale cert 失败（旧证书保留）: ${proc.stderr.toString().trim()}`);
    return 1;
  }
  const next = inspect(tmpCert, tmpKey);
  const v = validateCertCandidate({ host, ...next, minDays: MIN_DAYS });
  if (!v.ok) { cleanup(); console.error(`✗ 新证书不合格（旧证书保留）: ${v.reason}`); return 1; }

  for (const f of [CERT, KEY]) if (existsSync(f)) copyFileSync(f, `${f}.bak`);
  chmodSync(tmpKey, 0o600);
  renameSync(tmpCert, CERT);
  renameSync(tmpKey, KEY);
  console.log(`✓ 已替换，新证书剩 ${Math.floor(v.daysLeft)} 天；旧文件备份为 *.bak。记得重启/重载反代。`);
  return 0;
}

process.exit(await main());
