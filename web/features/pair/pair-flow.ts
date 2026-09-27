/**
 * 配对流程的编排（无 React，UI 在 pair-screen.tsx）：
 *   扫码 / 点链接：`#<fp>.<secret>` → 取挑战 → 浏览器算 HMAC → POST proof → 拿凭据 cookie；秘密不出浏览器。
 *   手输短码：中继 codes/lookup 找到 fp（直托管就是本机）→ POST {code} 进待确认 → 每 1.5s 轮询，直到 Mac 侧点头 / 拒绝 / 过期。
 * 成功后机器进清单并设为当前，principalId 一并记下（历史里「哪条是我发的」按它认，见 lib/chat/history-shape.ts）。
 */
import type { AppConfig } from "@/lib/app-config";
import { LOCAL_FP } from "@/lib/app-config";
import { machines } from "@/lib/machines";
import { hmacProof } from "@/lib/pairing";
import { codeLookup, pairChallenge, pairStatus, pairWithCode, pairWithProof, type ApprovalStatus, type PairedInfo } from "@/lib/api/devices";

export const POLL_INTERVAL_MS = 1_500;
export const POLL_DEADLINE_MS = 10 * 60_000;

export async function pairByProof(fp: string, secret: string, deviceName: string): Promise<PairedInfo> {
  const { challenge } = await pairChallenge(fp);
  const hmac = await hmacProof(secret, challenge);
  return pairWithProof(fp, { challenge, hmac }, deviceName);
}

/** 短码属于哪台机器：中继要查一次；直托管只有本机，跳过查找 */
export async function resolveCodeTarget(cfg: AppConfig, code: string): Promise<{ fp: string; name: string }> {
  if (cfg.mode === "direct") return { fp: cfg.fp || LOCAL_FP, name: cfg.machineName };
  const r = await codeLookup(code);
  return { fp: r.fp, name: r.name };
}

export function startCodePairing(fp: string, code: string, deviceName: string) {
  return pairWithCode(fp, code, deviceName);
}

/** 轮询到终态为止；signal 中止（用户离开页面）就抛 AbortError */
export async function pollApproval(
  fp: string,
  approvalId: string,
  opts: { signal?: AbortSignal; intervalMs?: number; deadlineMs?: number; onTick?: () => void } = {},
): Promise<Exclude<ApprovalStatus, { state: "pending" }>> {
  const until = Date.now() + (opts.deadlineMs ?? POLL_DEADLINE_MS);
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  while (true) {
    if (opts.signal?.aborted) throw new DOMException("pairing cancelled", "AbortError");
    const st = await pairStatus(fp, approvalId, opts.signal);
    if (st.state !== "pending") return st;
    opts.onTick?.();
    if (Date.now() > until) return { state: "expired" };
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** 配对成功：机器进清单（保留 principalId）并设为当前 */
export async function finishPairing(info: PairedInfo, fallbackFp: string): Promise<string> {
  const fp = info.fp || fallbackFp;
  await machines.add({ fp, name: info.machineName || fp, principalId: info.principalId });
  await machines.setCurrent(fp);
  return fp;
}
