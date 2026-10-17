/**
 * 机器代际校验（切机窗口）：machines.setCurrent 一进来就换当前机器、代际 +1，但聊天 store / 页面要等持久化写完才清空。
 * 这段窗口里旧页面上的操作（打断 / 发消息 / 清空 / 协作页叫停）若在发请求时才读当前机器，就会打到新机器的同名 agent。
 * 页面在载入时 captureMachine() 记下 {fp, gen}，操作前 assertMachine 或把它作为 api() 的 expect 传下去，对不上就不发请求。
 * 只在中继模式下生效：直托管只有一台机器，行为不变。
 */
import { appConfigSync } from "@/lib/app-config";
import { ApiError } from "@/lib/api/client";
import { machines, type MachineStamp } from "@/lib/machines";

export const MACHINE_SWITCHED = "machine_switched";
/** 轻提示文案（打断菜单的 alert、会话里的提示行都用这一句） */
export const MACHINE_SWITCHED_TEXT = "已切换机器，操作未发送";

export function captureMachine(): MachineStamp {
  return { fp: machines.currentFp(), gen: machines.generation() };
}

/** 中继模式下当前机器或代际已不是捕获时那台；配置还没到的先放行，api() 拿到配置后会用 expect 再核一次 */
export function machineSwitched(expected: MachineStamp): boolean {
  if (appConfigSync()?.mode !== "relay") return false;
  return machines.generation() !== expected.gen || machines.currentFp() !== expected.fp;
}

export function assertMachine(expected: MachineStamp): void {
  if (machineSwitched(expected)) throw new ApiError(MACHINE_SWITCHED_TEXT, 0, { notSent: true }, MACHINE_SWITCHED);
}

/** 发出前被切机校验拒掉的（本地 assertMachine 或 api() 的 expect 核对）；在途时切机的迟到响应也是 machine_switched，但请求已发出，不算 */
export function isMachineSwitched(e: unknown): boolean {
  return e instanceof ApiError && e.code === MACHINE_SWITCHED && e.body.notSent === true;
}
