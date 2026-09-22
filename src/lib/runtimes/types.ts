/**
 * 运行时适配层（v2.24+）—— owner 2026-09-22：「不要每样都做一套。加一些标准接口，
 * 让它可扩展性强一点，日后还要加别的。」
 *
 * ## 为什么需要
 *
 * 到 Codex 为止我们有三种运行时，而每加一种，散在各处的 `if (runtime === "pi")`
 * 就多一批：manager 的 create 与 resume 各抄了同一套五步（可用性检查 → 清就绪标记 →
 * 等就绪 → 文案 → registry 字段），session-source 有三条分支，manager 有三个
 * scanXxxSessions。漏改一处的症状都是「某个入口把 A 运行时当 B 起/读」，而这种
 * 错误不报错、只是行为不对，排查成本远高于抽象本身。
 *
 * ## 分两层，因为现实就是两层
 *
 * - `SessionSourceAdapter`：**能被看见**。扫会话、定位文件、把一行翻译成 Claude Code
 *   形状。只读，历史面板与会话列表要的就是这些。
 * - `ManagedRuntimeAdapter`：在此之上**还能被我们启动并对话**。多出启动命令、就绪
 *   判据、退出指令，以及「消息怎么送进去」。
 *
 * 这个分层不是为了好看：Codex 在补完生命周期之前只实现上层，类型系统会替我们挡住
 * 「给一个只读来源建 agent」这种事——而不是等到运行时报一句看不懂的错。
 */

export type AnyRecord = Record<string, any>;

/** 会话列表里的一条（三种来源统一成这个形状） */
export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  slug: string;
  modifiedAt: Date;
  lastUserMessage: string;
  runtime: string;
}

export interface SessionSourceAdapter {
  /** registry / API / 前端都用这个字符串认它 */
  readonly id: string;
  /** 给人看的名字 */
  readonly label: string;
  /** 能不能被 Claudestra 启动并对话（false = 只读来源，前端据此不给「收编」按钮） */
  readonly manageable: boolean;

  /** 扫本机这种运行时的所有会话 */
  scanSessions(search?: string): Promise<DiscoveredSession[]>;

  /**
   * cwd + sessionId → 文件路径。**推不出来就返回 null**（调用方转去全库扫描）——
   * Pi 与 Codex 的文件名都带时间戳前缀，光有 id 拼不出路径。
   */
  sessionPath(cwd: string, sessionId: string): string | null;

  /** 全库兜底查找（cwd 记错 / 路径推断失准时用） */
  findSessionById(sessionId: string): string | null;

  /** 某工作目录下的会话文件（fork 前后 diff、归档扫描用） */
  listSessionsForCwd(cwd: string): string[];

  /** 这个路径是不是这种运行时的会话文件（按根目录判，零 I/O） */
  ownsPath(path: string, home?: string): boolean;

  /**
   * 首行嗅探：归档副本的路径不带任何根特征，只能看内容。
   * 不实现 = 这种运行时没有可靠的头行签名。
   */
  sniffFirstLine?(firstLine: AnyRecord): boolean;

  /** 一行原文 → Claude Code 形状（不是对话内容返回 null） */
  translateLine(line: string): AnyRecord | null;
}

/**
 * ⚠ 生命周期那一层（启动命令 / 就绪判据 / 退出指令 / 消息注入）**故意还没定义在这里**。
 *
 * 它现在真实地散在 manager.ts 的 create 与 resume 里（各抄了一遍同样的五步），把它
 * 抽上来是下一步的事。先定义一个没人实现的 `ManagedRuntimeAdapter`、再让适配器写
 * `waitReady: async () => true` 这种占位，等于在接口里撒谎——调用方会以为问过适配器
 * 了，其实答案是假的。接口要么是真的，要么先别有。
 */
