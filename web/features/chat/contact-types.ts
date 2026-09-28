/** 联系人的形状（bridge src/lib/peer-contacts.ts 的 GET /api/v1/peers/contacts）。单独成文件：tests/ 测 mention.ts 时不牵进 React / DOM */
export interface ContactAgent {
  name: string;
  /** 对方说它已停止：侧栏标「已停止」，不进 @ 候选 */
  stopped?: boolean;
  /** 缺省 = 不知道（对方老版本不返回、目录过期、对方离线）→ 显示「—」 */
  busy?: boolean;
}

export interface PeerContact {
  name: string;
  fp?: string;
  /** true 在线 / false 连不上 / null 单向（只有对方能连我们） */
  online: boolean | null;
  /** 对方开放给我的 agent；stale = 目录超过 3 分钟没刷新，此时 bridge 不给忙闲 */
  agents: ContactAgent[];
  stale: boolean;
  /** 对方拒绝了我们的凭据（401 / 403），列表因此是空的 */
  rejected?: boolean;
  /** 以下都是 ISO 时间：上次在线 / 对方上次来访 / 目录上次刷新 */
  lastOnlineAt?: string;
  lastInboundAt?: string;
  checkedAt?: string;
}
