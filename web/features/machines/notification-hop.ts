import { machines } from "@/lib/machines";

/**
 * 点通知打开会话（chat.tsx 收 sw.js 的 cstra-open-agent）：通知来自另一台已配对的机器（payload 带 fp）时先切机器——
 * 同一个聊天 store 换数据源（reset），再开那台机器上的会话；同一台 / 不认识的 fp 直接开。
 */
export async function hopThenOpen(fp: string | undefined, reset: () => void, open: () => Promise<unknown>): Promise<void> {
  if (fp && fp !== machines.currentFp() && machines.get(fp)) {
    await machines.setCurrent(fp);
    reset();
  }
  await open();
}
