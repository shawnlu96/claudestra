/**
 * 「转交」：用户把消息发错了 agent（比如想找 gc-car-chat 却发给了 gc-car），收到的 agent 把**原话**
 * 交给该接手的 agent，由它直接回用户，原 agent 不再回复（owner 2026-09-24 拍板 fwd_auto_go）。
 * 与 send_to_agent 不同：那是「请同事帮忙」，同事的回答推回给我、我再转述；转交后回答直接到用户。
 * 这里是纯规则（tests/forward.test.ts），投递在 bridge/forward.ts。
 */
const FORWARD_TOOL = "forward_to_agent";

/** Claude Code 侧是 MCP 名 mcp__<MCP_NAME>__forward_to_agent，Pi 侧是裸名 */
export function isForwardTool(name: string): boolean {
  return name === FORWARD_TOOL || (name.startsWith("mcp__") && name.endsWith(`__${FORWARD_TOOL}`));
}

/** 原对话里留下的那一行（直播事件与历史记录同一份文案；[[{.agent}x]] 在网页上是可点的跳转） */
export function forwardNotice(target: string): string {
  return `↪ 已转给 [[{.agent}${target.replace(/^agent-/, "")}]]`;
}

/** 投给接手方时加在原话前面的说明 */
export function forwardHeader(fromAgent: string, reason: string): string {
  const why = reason.trim() ? `（${reason.trim()}）` : "";
  return `[↪ 由 ${fromAgent} 转来：用户原本发给了 ${fromAgent}，它判断该由你处理${why}。` +
    `直接 reply 回答用户即可，不用回 ${fromAgent}；这条已经转过一次，不能再转。]`;
}

export interface ForwardCheck {
  /** 原消息来源：user = Discord 人类，api = Web / API 用户 */
  srcKind: string;
  peer?: string;
  forwarded: boolean;
  fromAgent: string;
  target: string;
  targetExists: boolean;
  targetOnline: boolean;
  targetIsMaster: boolean;
  inScope: boolean;
}

/** 能不能转：能 → null；不能 → 给 agent 看的原因（它据此改为回复用户） */
export function forwardVerdict(c: ForwardCheck): string | null {
  if (c.forwarded) return "这条消息已经被转过一次，不能再转（防止来回踢皮球）——请直接回答，或告诉用户该找谁";
  if (c.srcKind !== "user" && c.srcKind !== "api") return "只能转交用户直接发来的消息";
  if (c.peer) return "peer 实例发来的请求不能转交——对方在等你本人的回复";
  if (c.targetIsMaster) return "不能转给大总管";
  if (c.target === c.fromAgent) return "不能转给自己";
  if (!c.targetExists) return `找不到 agent「${c.target}」——先用 project_info 看看有哪些 agent`;
  if (!c.inScope) return `这位用户没有访问「${c.target}」的权限，不能转过去`;
  if (!c.targetOnline) return `「${c.target}」现在不在线，转过去没人接——请告诉用户这件事该找它，让用户去它那边发`;
  return null;
}
