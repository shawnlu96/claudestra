/**
 * 控制频道（大总管）的注册准入（纯逻辑，单测在 tests/control-registrant.test.ts）。
 *
 * ## 为什么需要它
 *
 * 2026-09-21 21:41 起，owner 机器上两个大总管抢 `#control` 抢了三个多小时：
 * window 0 是生产的（cwd `~/repos/claudestra/master`），window 20 是 **dev worktree**
 * 里起的（cwd `~/repos/claudestra-dev/master`）。10 分钟内互相顶替 **19 次**。
 *
 * 根因不是"谁不小心开了第二个"，而是 **dev worktree 的 master 天然继承生产环境**：
 * 它的启动命令带着
 *
 * ```
 * DISCORD_CHANNEL_ID=<生产的 CONTROL_CHANNEL_ID>
 * BRIDGE_URL=ws://localhost:3847        # 生产 bridge
 * ```
 *
 * 于是它一起来就必然去认领同一条频道。后果不止是日志刷屏：发给 #control 的消息由
 * "最后一次抢赢的那个"接（不确定是哪个），而它跑的 `manager.ts` 写的是**同一份
 * registry**，dev 里建的 agent 会变成真 agent。
 *
 * `lib/channel-contention.ts`（v2.22）能**抓到**这个形态并告警，但拦不住——只要还会
 * 在 dev worktree 里起 master，它就会再来一次。这里补上那一道闸。
 *
 * ## 判据：cwd 必须是 MASTER_DIR
 *
 * 控制频道只有一个正当持有者：跑在 `MASTER_DIR` 里的那个大总管。正常重启 cwd 不变
 * （所以不误伤顶替语义），dev/实验实例的 cwd 必然不同（所以一注册就被挡回去，连内战
 * 都打不起来）。
 *
 * 只对控制频道生效——普通 agent 的频道按 agent 分，cwd 本来就各式各样。
 *
 * ## 三处刻意 fail-open
 *
 * 拒绝注册的代价是"那个实例没有通道"，所以**拿不准就放行**：
 *   1. `CONTROL_CHANNEL_ID` 没配 → 放行（单机/测试环境）；
 *   2. 注册帧不报 cwd（老版本 channel-server）→ 放行，不靠猜；
 *   3. `realpath` 解析不了（目录被移走等）→ 退回 `path.resolve` 的词法比较；
 *   4. 连 `MASTER_DIR` 都解析不出来 → 放行（没有可信对照物时，绝不能把正主锁在门外）。
 */

import { realpathSync } from "fs";
import { resolve } from "path";

export interface ControlRegistrantVerdict {
  allow: boolean;
  /** 拒绝时写进日志/告警的原因（放行时不带） */
  reason?: string;
}

interface NormalizedDir {
  path: string;
  /** realpath 是否真的解析成功（失败 = 我们对这个目录没有把握） */
  resolved: boolean;
}

/**
 * 先 `path.resolve`（纯字符串、必定成功），再试 `realpath`。
 *
 * ⚠ 两步都要，缺一不可（2026-09-21 实测抓到）：`MASTER_DIR` 的缺省值是
 * `` `${REPO_ROOT}/master` ``，而 `REPO_ROOT` 自己带着 `../..`，拼出来是
 * `/…/src/bridge/../../master`。只 realpath 的话，目录一旦解析不了就退回**这个原样
 * 字符串**，跟干净的 `process.cwd()` 永远比不相等 ⇒ **连正主都会被拒**。
 * 纯逻辑单测发现不了这一条（fixture 里路径都是干净的），是拿真实 MASTER_DIR 跑一遍
 * 才露出来的。
 */
function normalizeDir(p: string, realpath: (p: string) => string): NormalizedDir {
  const lexical = resolve(p).replace(/\/+$/, "");
  try {
    return { path: realpath(lexical).replace(/\/+$/, ""), resolved: true };
  } catch {
    /* 目录不存在 / 权限不足：退回词法形式，并记下「没把握」 */
    return { path: lexical, resolved: false };
  }
}

export function checkControlRegistrant(opts: {
  /** 注册帧里的频道 */
  channelId: string;
  /** 本 bridge 的控制频道（未配置时为空串） */
  controlChannelId: string;
  /** 本 bridge 认的大总管工作目录 */
  masterDir: string;
  /** 注册帧自报的 cwd（老版本可能没有） */
  cwd?: string;
  /** 可注入，便于单测软链场景 */
  realpath?: (p: string) => string;
}): ControlRegistrantVerdict {
  const { channelId, controlChannelId, masterDir, cwd } = opts;
  if (!controlChannelId || channelId !== controlChannelId) return { allow: true };
  if (!cwd || !masterDir) return { allow: true };

  const rp = opts.realpath ?? realpathSync;
  const from = normalizeDir(cwd, rp);
  const want = normalizeDir(masterDir, rp);
  if (from.path === want.path) return { allow: true };

  // fail-open 第 4 条：MASTER_DIR 自己都解析不出来（目录不在 / 权限不足）⇒ 我们没有
  // 可信的对照物。宁可放行也不能把正主锁在自己的频道外面。
  if (!want.resolved) return { allow: true };

  return {
    allow: false,
    reason: `cwd ${cwd} 不是 MASTER_DIR ${masterDir}`,
  };
}
