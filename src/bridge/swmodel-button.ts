/**
 * 「Switch model?」/「Change effort level?」弹窗的旧代决按钮（swmodel_yes / swmodel_no）已停用：只回一句话，不发任何键。
 * 按钮点下去到键发出去之间，框可能关了又弹出一张内容相同的新框——bridge 与 manager 两个进程之间做不到「只批这一张、只批一次」，
 * 所以 permission-watcher 现在只发通知，owner 到终端或网页终端里自己按。这里只接住聊天记录里的旧按钮。
 * 自己触发的框（网页设置切模型、bridge 登记过意图的 /model）由 runSwitchCommand / permission-watcher 代按，不走按钮。单测 tests/send-key-guard.test.ts。
 */
export const isSwmodelButton = (id: string): boolean => id.startsWith("swmodel_yes:") || id.startsWith("swmodel_no:");

export const SWMODEL_RETIRED = "⌛ 这个按钮已停用，没发任何键：切模型 / effort 的确认框请到终端或网页终端里自己按（选「1. Yes」回车 = 切换，Esc = 保持现状）";

export const handleSwmodelButton = async (): Promise<{ text: string }> => ({ text: SWMODEL_RETIRED });
