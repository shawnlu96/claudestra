/**
 * 全量测试闸的宿主策略（docs/architecture/full-test-gate.md）：`<宿主状态根>/locks/full-tests/policy.json`。
 * 目录只认 stateDirIn(homedir())，不跟 CLAUDESTRA_STATE_DIR：tests/preload.ts、worktree、沙箱都会把它换成各自的目录，
 * 跟着它走就等于每个进程各有自己的上限。不放 config.json：config-store 白名单式读写会抹掉未知键。
 * 读不出 / 坏值 / on 缺 source 一律按 observe，并给出说明（notes）——不静默声称已限流。tests/full-test-gate.test.ts。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LendCheckConfig } from "./lend-check-permit.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { stateDirIn } from "./state-dir.js";

const DEFAULT_MAX = 2;
const DEFAULT_MAX_WAIT_MIN = 60;
const APPROVED_BY = "full-test-gate policy.json";
/** observe 没写 source 时的批准出处占位：observe 不限流，max 只用来算「on 档下会排第几」 */
const OBSERVE_REFERENCE = "observe-default";

const positive = z.number().int().positive().safe();
const policySchema = z.object({
  mode: z.enum(["off", "observe", "on"]),
  max: positive.optional(),
  maxWaitMin: positive.optional(),
  source: z.string().trim().min(1).max(1024).optional(),
});
export type GatePolicyFile = z.infer<typeof policySchema>;
export type GatePolicy = { mode: "off" | "observe" | "on"; max: number; maxWaitMin: number; source: string | null; notes: string[] };

export function fullTestGateDir(home = homedir()): string {
  return join(stateDirIn(home), "locks", "full-tests");
}

export function policyPath(dir: string): string {
  return join(dir, "policy.json");
}

export function parseGatePolicy(data: unknown): GatePolicyFile | null {
  const parsed = policySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function readGatePolicy(dir: string): GatePolicy {
  const read = readJsonStateSync(policyPath(dir));
  const fallback = (note?: string): GatePolicy =>
    ({ mode: "observe", max: DEFAULT_MAX, maxWaitMin: DEFAULT_MAX_WAIT_MIN, source: null, notes: note ? [note] : [] });
  if (read.status === "missing") return fallback();
  if (read.status === "corrupt") return fallback(`policy.json 读不出（${read.error}），按 observe 处理`);
  const file = parseGatePolicy(read.data);
  if (!file) return fallback("policy.json 内容无效（mode 须为 off|observe|on，max / maxWaitMin 须为正整数），按 observe 处理");
  const policy: GatePolicy = {
    mode: file.mode, max: file.max ?? DEFAULT_MAX, maxWaitMin: file.maxWaitMin ?? DEFAULT_MAX_WAIT_MIN, source: file.source ?? null, notes: [],
  };
  if (policy.mode === "on" && !policy.source) {
    return { ...policy, mode: "observe", notes: ["policy.json 是 on 但缺 source（批准出处），按 observe 处理：不限流，只登记"] };
  }
  return policy;
}

export function writeGatePolicy(dir: string, file: GatePolicyFile): void {
  writeJsonAtomicSync(policyPath(dir), file, { mode: 0o600, trailingNewline: true });
}

/** 交给 lendCheckPermit 的配置；批准由 verifier 对照同一份宿主策略核验，不认调用方自报的数字 */
export function permitConfig(policy: GatePolicy): LendCheckConfig {
  if (policy.mode === "off") return { mode: "off" };
  return {
    mode: policy.mode,
    ownerApproval: { maxConcurrentFullChecks: policy.max, approvedBy: APPROVED_BY, reference: policy.source ?? OBSERVE_REFERENCE },
  };
}

export function approvalVerifier(policy: GatePolicy): (approval: NonNullable<LendCheckConfig["ownerApproval"]>) => boolean {
  return (a) => a.approvedBy === APPROVED_BY && a.maxConcurrentFullChecks === policy.max && a.reference === (policy.source ?? OBSERVE_REFERENCE);
}
