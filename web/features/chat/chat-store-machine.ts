/**
 * 聊天 store 的页面数据属于哪台机器（lib/machine-guard.ts）。切机时 machines.setCurrent 立刻换代际，
 * 但 store 要等持久化写完才 resetForMachine：这段窗口里旧页面的打断 / 发消息 / 清空不许落到新机器的同名 agent。
 * store 在首次打开会话、换数据源时记下 captureMachine()；动作前本地先核，请求再带 expect 让 api() 发出前再核一次。
 */
import { captureMachine, isMachineSwitched, machineSwitched, MACHINE_SWITCHED_TEXT } from "@/lib/machine-guard";
import type { MachineStamp } from "@/lib/machines";

export class PageMachine {
  private stamp: MachineStamp | null = null;
  /** notify：在会话里留一行轻提示（store 翻译后 pushNotice；本模块不碰 i18n，保持纯逻辑可测） */
  constructor(private notify: (text: string) => void) {}

  /** 换数据源（resetForMachine）：之后载入的数据属于此刻的当前机器 */
  adopt(): void {
    this.stamp = captureMachine();
  }
  /** 首次打开会话（MachineGate 已等机器清单就位）：还没记过才记 */
  adoptOnce(): void {
    this.stamp ??= captureMachine();
  }
  /** 给 api() 的 expect；还没记过 = 不核（与改前一致） */
  get expect(): MachineStamp | undefined {
    return this.stamp ?? undefined;
  }

  /** 动作前调：页面已是旧代际 → 留提示并返回拒绝结果，不发请求；null = 可以发 */
  refusal(): { ok: false; error: string } | null {
    if (!this.stamp || !machineSwitched(this.stamp)) return null;
    this.notify(MACHINE_SWITCHED_TEXT);
    return { ok: false, error: MACHINE_SWITCHED_TEXT };
  }
}

/** postAction 的错误文案：被切机校验拒掉的统一说「已切换机器，操作未发送」 */
export function actionErrorText(e: unknown): string {
  return isMachineSwitched(e) ? MACHINE_SWITCHED_TEXT : (e as Error).message || "操作失败";
}
