/**
 * ACP 宿主按运行时不同的那几处，读注册表里的运行时描述（runtimes/contract.ts AcpHostRuntime，各家在 runtimes/<id>-acp-host.ts）。
 * 宿主命令不带 CLAUDESTRA_ACP_RUNTIME = codex（老命令照旧）；认不出的值直接抛，不猜。tests/acp-host-runtime.test.ts。
 */
import { ACP_RUNTIME_ENV, type AcpHostRuntime } from "../runtimes/contract.js";
import { acpHostFor, acpRuntimeIds } from "../runtimes/index.js";

export { ACP_RUNTIME_ENV };
export { PI_ARGS_ENV } from "../runtimes/pi-acp-host.js";
export type AcpRuntime = AcpHostRuntime;

export function acpRuntime(id?: string): AcpRuntime {
  const rt = acpHostFor(id || "codex");
  if (!rt) throw new Error(`ACP 宿主不认识的运行时「${id}」（${ACP_RUNTIME_ENV} 只能是 ${acpRuntimeIds().join(" / ")}）`);
  return rt;
}
