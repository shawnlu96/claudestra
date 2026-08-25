/**
 * 只读用量看板（v2.4.25+）
 *
 * 一个只读频道（📊-claudestra-stats）里常驻一条 embed 消息，每次「对话完成」hook 就
 * 编辑它 —— 走消息编辑限流（~5/5s per channel），几乎不受限，避开了改 topic 那条严格的
 * 2 次/10min。数据两块：
 *   - per-agent（上下文 / 模型 / 今日·本周 token）：本地 JSONL 即时算（agent-stats.ts）
 *   - 账号级 5h/周 limit 占比：抓 /status 面板（慢变化，缓存 3min，惰性由 hook 触发刷新）
 *
 * 同一份快照另开 `GET /stats` JSON 接口，给以后的 Web 端。
 */

import {
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Client,
  type TextChannel,
} from "discord.js";
import { existsSync, readFileSync, statSync } from "fs";
import {
  tmuxRaw,
  MASTER_SESSION,
  paneLooksIdle,
  TMUX_SOCK,
  tmuxSendEscape,
  isRewindDialog,
  ESC_DOUBLE_TAP_MS,
  windowTarget,
  tmuxSendLine,
} from "../lib/tmux-helper.js";
import { readConfig, setStatsDashboard } from "../lib/config-store.js";
import { readRegistryAgents } from "../lib/registry.js";
import { discordCreateChannel } from "./discord-api.js";
import {
  computeAgentStats,
  formatTokens,
  type AgentStat,
  type AgentLike,
} from "../lib/agent-stats.js";

const DASHBOARD_CHANNEL_NAME = "📊-claudestra-stats";
const ACCOUNT_TTL_MS = 3 * 60 * 1000; // 账号级 %，慢变化，3min 才重抓
const DEBOUNCE_MS = 3000; // 合并瞬时连发的多个 hook
const TICK_MS = 10 * 60 * 1000; // 低频兜底：挂机没 hook 时也刷一次，反映 5h/周 limit 重置

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AccountUsage {
  sessionPct: number | null;
  sessionResets: string;
  weekPct: number | null;
  weekResets: string;
  totalCost: string | null;
  apiDuration: string | null;
  /** 去掉进度条字符后的 Usage 面板原文（保底：Web 端要什么都能再解析） */
  raw: string;
  scrapedAt: number;
}

export interface StatsSnapshot {
  global: AccountUsage | null;
  agents: AgentStat[];
  updatedAt: number;
}

// ── 账号级 /status 抓取 ────────────────────────────────────────────────

let accountCache: AccountUsage | null = null;
let scraping: Promise<AccountUsage | null> | null = null;

function parseUsagePanel(raw: string): AccountUsage {
  const lines = raw.split("\n");
  let sessionPct: number | null = null;
  let sessionResets = "";
  let weekPct: number | null = null;
  let weekResets = "";
  for (let i = 0; i < lines.length; i++) {
    const anchor = /Current session/.test(lines[i])
      ? "session"
      : /Current week/.test(lines[i])
        ? "week"
        : null;
    if (!anchor) continue;
    // 搜索窗放宽到 +7:窄窗口(手机终端页把 tmux 钳到 ~52 列)下锚行/进度条
    // 折行,"% used" 会掉到 +4 之外(2026-07-14 weekPct null 实锤)
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      const pm = lines[j].match(/(\d+)%\s*used/);
      const rm = lines[j].match(/Resets\s+(.+?)\s*$/);
      if (anchor === "session") {
        if (pm && sessionPct === null) sessionPct = Number(pm[1]);
        if (rm && !sessionResets) sessionResets = rm[1].trim();
      } else {
        if (pm && weekPct === null) weekPct = Number(pm[1]);
        if (rm && !weekResets) weekResets = rm[1].trim();
      }
    }
  }
  const cost = raw.match(/Total cost:\s*\$([\d.,]+)/);
  const durApi = raw.match(/Total duration \(API\):\s*([^\n]+)/);
  // raw 只留 Usage 面板本身;取「最后一个」tab 行起——万一仍有残留,后者才是当前面板
  let startIdx = lines.findLastIndex((l) => /Settings\s+Status\s+Config\s+Usage/.test(l));
  if (startIdx < 0) startIdx = lines.findIndex((l) => /^\s*Session\s*$/.test(l));
  if (startIdx < 0) startIdx = 0;
  const cleaned = lines
    .slice(startIdx)
    .filter((l) => l.trim() && !/^[\s█▉▊▋▌▍▎▏░▓]+$/.test(l))
    .map((l) => l.replace(/[█▉▊▋▌▍▎▏░▓]+/g, "").replace(/\s+$/, ""))
    .join("\n");
  return {
    sessionPct,
    sessionResets,
    weekPct,
    weekResets,
    totalCost: cost ? cost[1] : null,
    apiDuration: durApi ? durApi[1].trim() : null,
    raw: cleaned.slice(0, 3500),
    scrapedAt: Date.now(),
  };
}

/**
 * 驱动 master:0 的 /status，确定性导航到 Usage tab，抓 session/week 占比。
 * master 忙就返回 null（用旧缓存）。全程本地、不调用 LLM。
 */
// v2.17.1 判据统一(peer 报告:此前自带判据把「挂着的 usage 面板」判 idle,
// 与 tmux-helper 的 paneIdleVerdict 相反,构成污染自持回路——污染源被反复
// 选中抓取)。收敛到 paneLooksIdle 单一来源,并显式排除面板痕迹。
function paneIdle(pane: string): boolean {
  if (panelResidue(pane)) return false;
  return paneLooksIdle(pane);
}

/**
 * 敲入 /status 之后的 TOCTOU 二次确认——反向判据(v2.17.2,peer 二层定案:
 * 敲入本身会弹 slash 补全菜单,窄 pane 上条目换行可达 11 行,把 ❯ 顶出
 * paneLooksIdle 的 last5 窗口——任何**正向 idle 判据**必被我方自己敲的字符
 * 否决,recheck 每轮自我否决,抓取 100% 失败且零日志。宽 pane 菜单不换行
 * 恰好侥幸存活,掩盖了问题)。
 *
 * recheck 真正要防的只有两件事,直接查它们:
 * 1) 选窗到敲入的几百 ms 间有消息进来开了回合(esc to interrupt)——Enter 会
 *    把队列文本当消息提交;
 * 2) 输入行内容不是纯我方敲入——用户半截输入被并进去了,Enter 会把它发出去。
 * 补全菜单在场是敲入的**预期结果**,不是危险信号。
 */
export function typedRecheckOk(pane: string, typed: string): boolean {
  if (/esc to interrupt/i.test(pane)) return false;
  const promptLines = pane.split("\n").filter((l) => l.includes("❯"));
  if (!promptLines.length) return false; // 输入行都找不到,保守撤退
  const last = promptLines[promptLines.length - 1]!;
  const content = last.slice(last.indexOf("❯") + 1).replace(/[▎█]/g, "").trim();
  return content === typed;
}

/**
 * 抓取源 pane 上是否有**开着的** TUI 面板。
 *
 * v2.17.2 回归修复(peer 报告:全线停摆 6 天,24h 清场 319 次刷新 0 次):判据
 * 只能认「面板开着」的独有特征,不能认「面板关过」的痕迹——
 * - `⎿ Settings dialog dismissed` 是抓取自己收尾产生的**回执文本**,闲置窗口
 *   没有新输出把它顶走,按残留处理 = 发一个没用的 Esc + 永久失格,窗口逐个
 *   毒死后 findIdleScrapeTarget 恒 null,抓取静默 bail(负 lookahead 排除);
 * - `Current session … % used` 会命中 transcript 里**引用**面板内容的对话
 *   (bug 报告贴用量数字就中招),删掉——Usage tab 真开着时 tab 栏
 *   `Settings Status Config Usage` 必在屏,由它覆盖。
 */
export function panelResidue(pane: string): boolean {
  // v2.19.0：Rewind 检查点对话框的页脚也是「Esc to cancel」,但它不是我们开的
  // 面板——认成残留就会周期性补 Esc 把它开开关关(2026-08-11 一夜毒死 8 个
  // agent 的放大器)。它归 maybeRecoverRewind 处理,这里一律不认。
  if (isRewindDialog(pane)) return false;
  return /Esc to cancel|Settings\s+Status\s+Config\s+Usage|Settings dialog(?!\s*dismissed)/.test(pane);
}

/**
 * 挑一个 idle 的 Claude 会话来抓 /status。账号 5h/周 gauge 是**全局**的（"all models"、
 * 固定 reset 时间），任何会话读都一样，所以不必非得读 master。之前固定读 master:0，
 * 但 master 作为大总管常年在忙 → idle 守卫每次 bail → gauge 永远冻结。优先 master，
 * 它忙就退回任意 idle agent 窗口（通常刚跑完 hook 的那个就是 idle 的）。
 */
async function findIdleScrapeTarget(): Promise<string | null> {
  // v2.16.1: agent 窗口优先,master 垫底(原来 master 排第一,吃下绝大多数抓取,
  // 而 master 是消息最密的窗口——TOCTOU 撞上刚开的回合就把大总管打断,外部
  // 用户实报「检查用量经常打断大总管」)。gauge 是账号全局的,谁的窗口都一样。
  const wins = (await tmuxRaw(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"]).catch(() => ""))
    .split("\n")
    .filter((w) => w.startsWith("agent-"));
  const candidates: string[] = wins.map((w) => `${MASTER_SESSION}:${w}`);
  candidates.push(`${MASTER_SESSION}:0`);
  for (const t of candidates) {
    const pane = await tmuxRaw(["capture-pane", "-t", t, "-p"]).catch(() => "");
    // v2.17.1 清场(peer 报告:遗留面板会让后续每轮抓取假命中冻结帧且 pane 假忙
    // 数小时):见面板痕迹先补一个 Esc,本轮跳过该窗,下轮它就干净可用了
    if (panelResidue(pane) && paneLooksIdle(pane.replace(/Esc to cancel|Settings\s+Status\s+Config\s+Usage|Settings dialog/g, ""))) {
      console.log(`📊 清场: ${t} 残留 TUI 面板,补发 Esc`);
      await tmuxSendEscape(t).catch(() => {});
      continue;
    }
    // Rewind 卡窗:多半是历史遗留(旧版收尾 Esc 间隔 350ms 撞上双击手势)。
    // 单发一个护栏 Esc 救回,本轮跳过,下轮它就是干净的可用窗口。
    if (isRewindDialog(pane)) {
      console.log(`📊 ${t} 卡在 Rewind 对话框,发一个 Esc 救回`);
      await tmuxSendEscape(t).catch(() => {});
      continue;
    }
    if (paneIdle(pane)) return t;
  }
  return null;
}

/**
 * v2.19.0 收尾自查：抓取结束后窗口若停在 Rewind 检查点对话框，单发一个护栏 Esc
 * 救回并复核。只对**本次抓取动过的那个窗口**做，不巡检全局——用户自己打开
 * Rewind 在读的窗口不该被我们关掉，而这个窗口刚被我们敲过键，责任明确。
 */
async function recoverRewindIfStuck(target: string): Promise<void> {
  try {
    const pane = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
    if (!isRewindDialog(pane)) return;
    console.log(`📊 收尾自查: ${target} 停在 Rewind 对话框,发 Esc 救回`);
    await tmuxSendEscape(target);
    await sleep(600);
    const after = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
    if (isRewindDialog(after)) console.log(`📊 ⚠️ ${target} 的 Rewind 未能关闭,留给 watcher 兜底`);
  } catch { /* best-effort */ }
}

/** 手动点「🔄 刷新」置位：本次抓取要更执着（多轮等 idle 窗口），不许静默放弃 */
let forceNextScrape = false;

/** v2.17.1 进程级收尾兜底(peer 报告:update/reload 在抓取中途杀 bridge,收尾
 *  Esc 永远发不出,面板遗留污染后续所有轮次)。SIGTERM/SIGINT 时若有抓取在
 *  途,同步补一个 Esc 再退。 */
let scrapeTargetInFlight: string | null = null;
let sigHooked = false;
function hookScrapeCleanupSignals() {
  if (sigHooked) return;
  sigHooked = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (scrapeTargetInFlight) {
        try {
          // v2.19.0:退出前这一发也不能是盲发——面板早关了还补 Esc,若与收尾
          // 循环刚发的那一发凑成 600ms 内的双击,就把窗口留在 Rewind 里了。
          // 同步读一眼:面板真开着才发,并先 sleep 满双击护栏(异步 sleep 在
          // 信号处理里跑不完,只能借 spawnSync)。
          const pane = Bun.spawnSync([
            "tmux", "-S", TMUX_SOCK, "capture-pane", "-t", scrapeTargetInFlight, "-p",
          ]).stdout.toString();
          if (panelResidue(pane)) {
            Bun.spawnSync(["sleep", String(ESC_DOUBLE_TAP_MS / 1000)]);
            Bun.spawnSync(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", scrapeTargetInFlight, "Escape"]);
          }
        } catch { /* 尽力而为 */ }
      }
      process.exit(0);
    });
  }
}

async function scrapeAccountUsage(): Promise<AccountUsage | null> {
  hookScrapeCleanupSignals();
  // 常规（hook/tick 触发）找不到 idle 窗口就算了，沿用旧缓存；手动刷新是用户
  // 明确要真实数据 —— 多等几轮（刚收尾的 agent 通常几秒内就 idle）。
  const attempts = forceNextScrape ? 5 : 1;
  forceNextScrape = false;
  let target: string | null = null;
  for (let k = 0; k < attempts && !target; k++) {
    if (k > 0) await sleep(2000);
    target = await findIdleScrapeTarget();
  }
  if (!target) {
    // v2.17.2 补日志(peer:整条链失败零输出,靠 ps 抓子进程才定位到)
    console.log("📊 找不到 idle 抓取源(候选全忙/有残留),沿用旧缓存");
    return null;
  }
  scrapeTargetInFlight = target; // SIGTERM 兜底靠它定位要补 Esc 的 pane
  try {
    await tmuxRaw(["send-keys", "-t", target, "-l", "/status"]);
    await sleep(150);
    // v2.16.1 TOCTOU 二次确认(外部用户实报「检查用量经常打断大总管」):
    // 选窗到此已过去几百 ms,期间可能恰好来消息开了回合——此时 Enter 会把
    // 队列文本当消息提交/把用户半截输入发出去。
    // v2.17.2 判据换反向的 typedRecheckOk——正向 paneIdle 会被我方敲入弹出的
    // 补全菜单自我否决(见函数注释,peer 二层定案:窄 pane 抓取 100% 失败)。
    const recheck = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
    if (!typedRecheckOk(recheck, "/status")) {
      console.log(`📊 recheck 撤退: ${target} 敲入后不安全(回合已开/输入行有他人内容),退格还原`);
      for (let i = 0; i < 7; i++) await tmuxRaw(["send-keys", "-t", target, "BSpace"]).catch(() => {});
      return null;
    }
    await tmuxRaw(["send-keys", "-t", target, "Enter"]);
    await sleep(500);

    let panel = "";
    let found = false;
    for (let i = 0; i < 6; i++) {
      // ⚠ 只抓可视屏,不带 scrollback(-S -80 会带出上一次 /status 的旧面板文本,
      // 锚在 Status tab 就假命中 → 解析到旧 session 值、week 被窗口切没
      // (2026-07-14 周用量「?%」实锤);锚定加 Current week——Usage tab 两条同屏
      panel = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
      if (/Current session/.test(panel) && /Current week/.test(panel) && /%\s*used/.test(panel)) {
        found = true;
        break;
      }
      // 还没到 Usage tab：右移一格，给足渲染时间再判断（避免过冲）
      await tmuxRaw(["send-keys", "-t", target, "Right"]);
      await sleep(300);
    }
    // ⚠ 首帧陷阱（owner 2026-07-14「停在 15% 很久了」实锤）：Usage tab 首帧画的是
    // CC 进程启动时的缓存快照，后台 fetch 完成后才原地刷新为真值——「一见锚就 capture」
    // 会永远抓到进程启动那一刻的值（master 长寿进程 → gauge 冻结）。锚定后再等一拍、
    // 用刷新后的帧解析（实测 15%/20% 冻结值 vs 等待后 74%/40% 真值）。
    if (found) {
      // v2.17 自适应等真值(外部用户实锤:真实 100% 而看板 0%——固定 1800ms
      // 没等到异步刷新,采纳了进程启动时的缓存首帧)。轮询到「数值相对首帧
      // 变化」或超时;真 0% 场景首帧即真值,多等几拍无害。
      const firstFrame = panel;
      for (let w = 0; w < 6; w++) {
        await sleep(1300);
        const refreshed = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
        if (!(/Current session/.test(refreshed) && /Current week/.test(refreshed) && /%\s*used/.test(refreshed))) continue;
        panel = refreshed;
        const a = parseUsagePanel(firstFrame);
        const b = parseUsagePanel(refreshed);
        if (a.sessionPct !== b.sessionPct || a.weekPct !== b.weekPct || a.sessionResets !== b.sessionResets) break;
      }
    }
    // 关闭面板恢复会话。v2.16.1: Escape 只在确认面板真的开着时才发——
    // 面板没开(Enter 落空/被吃)时的裸 Escape 若撞上刚开的回合就是硬中断,
    // 这正是「检查用量打断大总管」的杀伤路径。
    // v2.17.1 确认式收尾(peer 报告「Esc×2 间隔 80ms 疑被面板吞」+ master 单发
    // 一个 Esc 即关的实证):单发 → 验证 → 未关再发,至多 3 轮,绝不盲发。
    // v2.19.0:间隔从 350ms 提到 tmuxSendEscape 的 1200ms 护栏——350ms 正好落在
    // CC 的双击 Esc(Rewind)手势窗口内,收尾自己会把窗口捅进 Rewind 卡死。
    for (let e = 0; e < 3; e++) {
      const now = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
      if (!panelResidue(now) && !/Settings\s+Status\s+Config\s+Usage/.test(now)) break;
      await tmuxSendEscape(target);
      await sleep(350);
    }
    // 收尾后自查:若窗口落进了 Rewind(历史遗留状态/意外双击),自己捅出来的
    // 自己收拾——护栏保证这一发与上一发至少隔 1200ms,不会再触发手势。
    await recoverRewindIfStuck(target);
    if (!found) return null;
    const usage = parseUsagePanel(panel);
    // v2.17 合理性校验:session 窗口 ≤5h,解析出的重置时刻按「下一次出现」换算
    // 后若在 5.2h 之外 = 物理不可能 = 陈旧缓存帧(实锤截图:真值 Resets 12:20am,
    // 陈旧帧 Resets 3:50pm 距当时 16h)→ 丢弃本次,沿用旧缓存等下轮
    const tm = usage.sessionResets.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (tm) {
      let h = Number(tm[1]) % 12;
      if ((tm[3] || "").toLowerCase() === "pm") h += 12;
      const cand = new Date();
      cand.setHours(h, Number(tm[2]), 0, 0);
      if (cand.getTime() <= Date.now()) cand.setDate(cand.getDate() + 1);
      if (cand.getTime() - Date.now() > 5.2 * 3600_000) {
        console.log(`📊 丢弃陈旧用量帧: session reset "${usage.sessionResets}" 距今超 5h,判定为启动缓存快照 (via ${target})`);
        return null;
      }
    }
    console.log(`📊 账号用量已刷新: session=${usage.sessionPct}% week=${usage.weekPct}% (via ${target})`);
    scrapeTargetInFlight = null;
    return usage;
  } catch (e) {
    console.error("📊 /status 抓取失败:", (e as Error).message);
    try {
      // 同上:确认式收尾,面板在场才发,单发验证
      for (let e = 0; e < 3; e++) {
        const pane = await tmuxRaw(["capture-pane", "-t", target, "-p"]).catch(() => "");
        if (!panelResidue(pane)) break;
        await tmuxSendEscape(target);
        await sleep(350);
      }
      await recoverRewindIfStuck(target);
    } catch {}
    return null;
  }
}

/**
 * 带 TTL 缓存 + in-flight 去重的账号用量获取。抓不到就沿用旧缓存。
 * 关键：整个抓取套一层超时 —— 万一某次 tmux/osascript 卡住，`scraping` 也会在超时后
 * 复位，绝不会永久卡住让 gauge 冻结（这是之前 6h 不更新的根源之一）。
 */
async function getAccountUsage(block = true): Promise<AccountUsage | null> {
  if (accountCache && Date.now() - accountCache.scrapedAt < ACCOUNT_TTL_MS) return accountCache;
  if (!scraping) {
    scraping = Promise.race([
      scrapeAccountUsage(),
      // force 模式最多 5×2s 等 idle + 抓取本身 ~4s，超时给足 25s（仍防永久冻结）
      new Promise<null>((r) => setTimeout(() => r(null), 25000)),
    ])
      .then((u) => {
        if (u) accountCache = u;
        return accountCache;
      })
      .catch(() => accountCache)
      .finally(() => {
        scraping = null;
      });
  }
  // stale-while-revalidate：有旧值且调用方不要求阻塞 → 立刻回旧值，抓取在后台
  // 继续。Web 面板首开走这里——此前 TTL(3min) 一过就同步等活体抓取(4~25s)，
  // 把 BFF 非强制路径的 8s 超时拖爆 → 面板顶部大概率空白（2026-07-17 用户实报）。
  // 旧值的年龄面板有「抓取于 x 分钟前」标注,不会被当成实时。
  if (!block && accountCache) return accountCache;
  return scraping;
}

// ── 快照组装 ───────────────────────────────────────────────────────────

async function listAgents(): Promise<AgentLike[]> {
  return readRegistryAgents(); // RegistryAgent 是 AgentLike 超集（cwd 已归一含 dir 兼容）
}

export async function buildSnapshot(blockGauge = true): Promise<StatsSnapshot> {
  const [agents, global] = await Promise.all([
    listAgents().then((list) => computeAgentStats(list)),
    getAccountUsage(blockGauge),
  ]);
  agents.sort((a, b) => b.contextTokens - a.contextTokens);
  return { global, agents, updatedAt: Date.now() };
}

// ── Discord 渲染 ───────────────────────────────────────────────────────

function fmtResets(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim(); // 去掉尾部 (Asia/Singapore)
}

/**
 * 5h reset 时间是否可疑：reset 必落在抓取时刻的 5h 内，超出 = 上游 /status
 * 面板显示有误（Claude Code 2.1.204 实测过把 5pm 印成 5am）。只标记、不纠正 ——
 * 单一观测样本推不出错误形态，自动"翻转 am/pm"这类猜测可能把错值改成另一个
 * 错值还让用户无从发现；显示原文至少和用户自己跑 /status 看到的一致。
 * 周 reset 带日期无窗口约束，无从校验。
 */
export function sessionResetSuspect(s: string, scrapedAt: number): boolean {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)\b/i);
  if (!m) return false;
  const d = new Date(scrapedAt);
  d.setHours(
    (parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0), // 12am→0、12pm→12
    m[2] ? parseInt(m[2], 10) : 0, 0, 0,
  );
  if (d.getTime() <= scrapedAt) d.setDate(d.getDate() + 1);
  return d.getTime() - scrapedAt > 5 * 3_600_000;
}

/** 抓取时间 → "刚刚 / N 分钟前 / N 小时前"（用户要能看出 gauge 数据多旧） */
function fmtAge(scrapedAt: number): string {
  const ms = Date.now() - scrapedAt;
  if (ms < 90_000) return "刚刚";
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} 分钟前`;
  return `${(ms / 3_600_000).toFixed(1)} 小时前`;
}

function bar(pct: number | null, w = 10): string {
  if (pct == null) return "?".padEnd(w + 4);
  const f = Math.round((Math.min(100, pct) / 100) * w);
  return "▰".repeat(f) + "▱".repeat(w - f) + ` ${String(pct).padStart(3)}%`;
}

// 预警阈值（%）。上下文占用：≥75 该 compact 了；账号 limit：≥80 快撞墙。
const CTX_YELLOW = 50, CTX_RED = 75;
const LIMIT_YELLOW = 50, LIMIT_RED = 80;

function ctxDot(pct: number): string {
  return pct >= CTX_RED ? "🔴" : pct >= CTX_YELLOW ? "🟡" : "🟢";
}
function limitDot(pct: number | null): string {
  if (pct == null) return "⚪";
  return pct >= LIMIT_RED ? "🔴" : pct >= LIMIT_YELLOW ? "🟡" : "🟢";
}
/** embed 左侧边框色跟最严重的账号 limit 走：绿/黄/红 */
function limitColor(pct: number | null): number {
  if (pct == null) return 0x5865f2;
  return pct >= LIMIT_RED ? 0xed4245 : pct >= LIMIT_YELLOW ? 0xfee75c : 0x57f287;
}

/**
 * 用 Discord 原生 embed 字段渲染，而不是等宽代码块表格 ——
 * 代码块在窄手机屏（~33 字符）会硬折行、把列冲乱。原生字段全宽堆叠、按文字自然换行，
 * 还能用 emoji。每个 agent 一个非 inline 字段：名字前用颜色点表示上下文占用预警
 * （🟢正常 / 🟡偏高 / 🔴该 compact），value 行放模型 + 今日/本周。账号级 limit 两条
 * 进度条放在 description，也各带颜色点，边框色跟最严重的 limit 走。
 */
function renderEmbed(snap: StatsSnapshot): EmbedBuilder {
  const g = snap.global;
  const desc: string[] = ["**🌐 账号 limit（所有 agent 共享）**"];
  let worstLimit: number | null = null;
  if (g && (g.sessionPct != null || g.weekPct != null)) {
    worstLimit = Math.max(g.sessionPct ?? 0, g.weekPct ?? 0);
    desc.push(`⏱ 5h　${limitDot(g.sessionPct)} ${bar(g.sessionPct, 8)}${g.sessionResets ? "　⟳ " + fmtResets(g.sessionResets) + (sessionResetSuspect(g.sessionResets, g.scrapedAt) ? "⚠️" : "") : ""}`);
    desc.push(`📆 周　${limitDot(g.weekPct)} ${bar(g.weekPct, 8)}${g.weekResets ? "　⟳ " + fmtResets(g.weekResets) : ""}`);
    // gauge 数据年龄：embed 的 timestamp 是重渲染时间，账号 % 可能是旧缓存 ——
    // 不标年龄用户会以为一切都是最新的（owner 2026-07-10 报告"刷新不及时"的根源）
    const stale = Date.now() - g.scrapedAt > 15 * 60_000;
    desc.push(`_${stale ? "⚠️ " : ""}账号 gauge 抓取于 ${fmtAge(g.scrapedAt)}${stale ? "（点 🔄 强制重抓）" : ""}_`);
  } else {
    desc.push("_（/status 抓取中 / 无空闲会话可借，点 🔄 重试）_");
  }
  desc.push("_🟢 正常 · 🟡 偏高 · 🔴 需注意（点=上下文占用 / 前缀=limit）_");

  const emb = new EmbedBuilder()
    .setTitle("📊 Claudestra 用量看板")
    .setColor(limitColor(worstLimit))
    .setDescription(desc.join("\n"))
    .setFooter({ text: "本地 JSONL + /status · 每次对话完成自动更新" })
    .setTimestamp(new Date(snap.updatedAt));

  for (const a of snap.agents.slice(0, 24)) {
    const name = a.name.replace(/^agent-/, "");
    // compact 后无新对话 → 上下文是估算值，加 ~ 和标注（真实值下轮对话自动校准）
    const ctx = a.contextEstimated
      ? `📖 ~${formatTokens(a.contextTokens)} ${a.contextPct}%（刚 compact）`
      : `📖 ${formatTokens(a.contextTokens)} ${a.contextPct}%`;
    emb.addFields({
      name: `${ctxDot(a.contextPct)} ${name} · ${ctx}`,
      value: `${a.model.replace(/^claude-/, "")} · 今 ${formatTokens(a.today.tokens)} · 周 ${formatTokens(a.week.tokens)}`,
      inline: false,
    });
  }
  return emb;
}

// ── 频道 / 消息 保障 ───────────────────────────────────────────────────

async function ensureChannel(discord: Client): Promise<string | null> {
  const cfg = await readConfig();
  if (cfg.statsDashboard?.channelId) {
    const ch = await discord.channels.fetch(cfg.statsDashboard.channelId).catch(() => null);
    if (ch) return cfg.statsDashboard.channelId;
  }
  // 复用 discordCreateChannel，再把 @everyone 设成不可发言（只读）
  try {
    const chId = await discordCreateChannel(discord, DASHBOARD_CHANNEL_NAME);
    const ch = (await discord.channels.fetch(chId).catch(() => null)) as TextChannel | null;
    if (ch && ch.guild) {
      await ch.permissionOverwrites
        .edit(ch.guild.roles.everyone, { SendMessages: false, AddReactions: false })
        .catch(() => {});
      await ch.setTopic("Claudestra 实时用量看板（只读，自动更新）").catch(() => {});
    }
    await setStatsDashboard(chId, "");
    console.log(`📊 已创建用量看板频道: ${chId}`);
    return chId;
  } catch (e) {
    console.error("📊 创建看板频道失败:", (e as Error).message);
    return null;
  }
}

/** 看板消息底部的「🔄 刷新」按钮（点了强制立即刷新，绕过账号 gauge 的 3min 缓存）。 */
function refreshRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("stats_refresh").setLabel("🔄 刷新").setStyle(ButtonStyle.Secondary),
  );
}

/**
 * v2.5.4+ 「存记忆 + Compact」select menu：选一个 agent → bridge 往它的 tmux 发
 * /save-compact（skill：先挑重点存记忆，再自动 /compact）。Discord 没法把按钮放到
 * embed field "旁边"，一条消息也放不下每 agent 一个按钮，select 是最干净的形态。
 */
function saveCompactRow(agents: AgentStat[]) {
  const opts = agents
    .filter((a) => a.channelId)
    .slice(0, 25)
    .map((a) => ({
      label: a.name.replace(/^agent-/, "").slice(0, 100),
      value: a.channelId,
      description: `📖 ${formatTokens(a.contextTokens)} (${a.contextPct}%) · 今 ${formatTokens(a.today.tokens)}`.slice(0, 100),
      emoji: ctxDot(a.contextPct),
    }));
  if (!opts.length) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("stats_savecompact")
      .setPlaceholder("🧹 存记忆 + Compact…（选一个 agent）")
      .addOptions(opts),
  );
}

// ── 上下文阈值提醒 ─────────────────────────────────────────────────────
// 跨过一档提醒一次（250K/300K/400K/500K/750K），compact 掉下去自动复位、再涨再提醒。
// bridge 刚启动的第一轮只记 baseline 不提醒，避免每次重启把已超标的 agent 全轰一遍。

const CTX_TIERS = [250_000, 300_000, 400_000, 500_000, 750_000];
const notifiedTier = new Map<string, number>(); // channelId → 已提醒过的档位（1-based，0=没过档）
let tierBaselined = false;

const DEFAULT_AUTO_COMPACT_WINDOW = 400_000;
const autoCompactTriggered = new Map<string, boolean>(); // channelId → 本轮上涨已自动触发过 save-compact

function loadAutoCompactThreshold(): number {
  try {
    const raw = readFileSync(`${process.env.HOME || ""}/.claude/settings.json`, "utf8");
    const cfg = JSON.parse(raw);
    const v = cfg?.autoCompactWindow;
    if (v === false || v === 0) return 0; // 显式关闭
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // 没有全局配置或解析失败，用默认值
  }
  return DEFAULT_AUTO_COMPACT_WINDOW;
}

/** 闲置门槛(owner 2026-08-26「不然我干着干着就 compact 了」):超线只是必要条件,
 *  还得**闲置满 N 小时**才注入 /save-compact。~/.claude/settings.json 的
 *  autoCompactIdleHours 可调,0/false = 不要闲置门槛(回到超线即触发)。 */
const DEFAULT_AUTO_COMPACT_IDLE_HOURS = 3;

function loadAutoCompactIdleMs(): number {
  try {
    const raw = readFileSync(`${process.env.HOME || ""}/.claude/settings.json`, "utf8");
    const v = JSON.parse(raw)?.autoCompactIdleHours;
    if (v === false || v === 0) return 0;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n * 3600_000;
  } catch { /* 用默认 */ }
  return DEFAULT_AUTO_COMPACT_IDLE_HOURS * 3600_000;
}

/** 闲置判据 = 会话 jsonl 的 mtime(对话/工具活动都会写它;/status 抓取走 TUI
 *  面板不落 jsonl,实测几周才 1 条,不会把闲置刷没)。拿不到 jsonl → 判「不闲置」,
 *  宁可不触发也不打断。 */
function idleLongEnough(a: AgentStat, idleMs: number): boolean {
  if (idleMs <= 0) return true;
  if (!a.jsonl) return false;
  try {
    return Date.now() - statSync(a.jsonl).mtimeMs >= idleMs;
  } catch {
    return false;
  }
}

function tierOf(tokens: number): number {
  let t = 0;
  for (let i = 0; i < CTX_TIERS.length; i++) if (tokens >= CTX_TIERS[i]) t = i + 1;
  return t;
}

async function triggerAutoSaveCompact(a: AgentStat): Promise<void> {
  try {
    const target = a.name === "master" ? `${MASTER_SESSION}:0` : windowTarget(a.name);
    await tmuxSendLine(target, "/save-compact");
    console.log(`🧹 auto save-compact triggered: ${a.name} @ ${formatTokens(a.contextTokens)} (threshold=${formatTokens(loadAutoCompactThreshold())})`);
  } catch (e) {
    console.error(`🧹 auto save-compact 失败 (${a.name}):`, (e as Error).message);
  }
}

async function checkContextTiers(discord: Client, agents: AgentStat[]): Promise<void> {
  const threshold = loadAutoCompactThreshold();
  const idleMs = loadAutoCompactIdleMs();
  const first = !tierBaselined;
  tierBaselined = true;
  for (const a of agents) {
    if (!a.channelId) continue;
    const tier = tierOf(a.contextTokens);
    const prev = notifiedTier.get(a.channelId) ?? 0;
    if (tier !== prev) {
      notifiedTier.set(a.channelId, tier); // 涨了记新档；掉了（compact 过）复位
      // 上下文回落或跨过新高位：重置自动触发状态，允许下一轮再涨时再次触发
      autoCompactTriggered.delete(a.channelId);
    }
    if (tier === 0 || first) continue;

    // 自动触发：超线 + 闲置满门槛 + 本轮尚未触发。**每轮都查**(不只在跨档时)——
    // 超线但还在干活的,等它闲下来那轮再动手(owner 2026-08-26:别干着干着就 compact)
    if (
      threshold > 0 &&
      a.contextTokens >= threshold &&
      !autoCompactTriggered.get(a.channelId) &&
      idleLongEnough(a, idleMs)
    ) {
      autoCompactTriggered.set(a.channelId, true);
      await triggerAutoSaveCompact(a);
    }

    // 档位提醒只在**向上跨档**时发一次。18dec8f 把原 `tier === prev → continue`
    // 拆掉后,稳态每轮都会走到这里重发提醒(刷屏回归)——这行守卫补回原语义
    if (tier <= prev) continue;

    try {
      const ch = (await discord.channels.fetch(a.channelId).catch(() => null)) as TextChannel | null;
      if (!ch || !("send" in ch)) continue;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`savecompact:${a.channelId}`)
          .setLabel("🧹 存记忆 + Compact")
          .setStyle(ButtonStyle.Primary),
      );
      await ch.send({
        content: `⚠️ **${a.name.replace(/^agent-/, "")}** 上下文已到 **${formatTokens(a.contextTokens)}（${a.contextPct}%）**，超过 ${formatTokens(CTX_TIERS[tier - 1])} 档。建议先把关键信息存进记忆再 compact，一键搞定👇`,
        components: [row as any],
      });
      console.log(`📊 上下文档位提醒: ${a.name} → ${formatTokens(a.contextTokens)} (档${tier})`);
    } catch (e) {
      console.error(`📊 档位提醒失败 (${a.name}):`, (e as Error).message);
    }
  }
}

async function ensureMessage(
  discord: Client,
  channelId: string,
  embed: EmbedBuilder,
  extraRows: any[] = [],
): Promise<string | null> {
  const ch = (await discord.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!ch || !("send" in ch)) return null;
  const payload = { embeds: [embed], components: [refreshRow(), ...extraRows] };
  const cfg = await readConfig();
  const existingId = cfg.statsDashboard?.messageId;
  if (existingId) {
    const msg = await ch.messages.fetch(existingId).catch(() => null);
    if (msg) {
      await msg.edit(payload);
      return existingId;
    }
  }
  const msg = await ch.send(payload);
  await setStatsDashboard(channelId, msg.id);
  return msg.id;
}

// ── 对外：更新 / 初始化 / HTTP ─────────────────────────────────────────

let debTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pending = false;

async function doUpdate(discord: Client): Promise<void> {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    const snap = await buildSnapshot();
    const channelId = await ensureChannel(discord);
    if (!channelId) return;
    const menu = saveCompactRow(snap.agents);
    await ensureMessage(discord, channelId, renderEmbed(snap), menu ? [menu] : []);
    // 上下文跨档提醒（发到各 agent 自己的频道，带一键按钮）
    await checkContextTiers(discord, snap.agents);
  } catch (e) {
    console.error("📊 看板更新失败:", (e as Error).message);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      void doUpdate(discord);
    }
  }
}

/** 看板「🔄 刷新」按钮：强制刷新账号 gauge（清缓存年龄 + 多轮等 idle）+ 立即重渲染。 */
export async function forceRefreshStatsDashboard(discord: Client): Promise<void> {
  if (accountCache) accountCache.scrapedAt = 0; // 让下次 getAccountUsage 绕过 TTL
  forceNextScrape = true; // 本次抓取多轮等 idle 窗口，不许静默放弃
  await doUpdate(discord);
}

/** 每次「对话完成」hook 调这个（防抖合并瞬时连发）。 */
export function updateStatsDashboard(discord: Client): void {
  if (debTimer) return;
  debTimer = setTimeout(() => {
    debTimer = null;
    void doUpdate(discord);
  }, DEBOUNCE_MS);
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

/** 启动时确保频道 + 消息存在，刷一次，并起一个低频兜底 tick。 */
export async function initStatsDashboard(discord: Client): Promise<void> {
  try {
    await doUpdate(discord);
  } catch (e) {
    console.error("📊 看板初始化失败:", (e as Error).message);
  }
  // 低频兜底：主更新仍是「对话完成」hook，但挂机、没任何 hook 时账号 5h/周 limit 的
  // 重置就反映不出来。这个 tick 每 10min 刷一次补上（doUpdate 内部有 running 锁 + 账号
  // 抓取自带 TTL/超时，不会跟 hook 更新打架）。
  if (!tickTimer) tickTimer = setInterval(() => void doUpdate(discord), TICK_MS);
}

/** POST /stats/refresh —— Web 看板的「🔄 刷新」：与 Discord 刷新按钮
 *  同款语义（清缓存年龄 + force 多轮等 idle 强抓），抓完返回新快照。
 *  force 路径最长 ~20s（5×2s 等 idle + 抓取 + 稳定帧），调用侧超时给足。 */
export async function handleStatsRefreshRequest(): Promise<Response> {
  if (accountCache) accountCache.scrapedAt = 0;
  forceNextScrape = true;
  return handleStatsRequest(true);
}

/** GET /stats —— 开放 JSON 接口，给 Web 端。默认不阻塞在账号 gauge 活体抓取上
 *  （stale-while-revalidate，见 getAccountUsage）；强制刷新路径才阻塞等新值。 */
export async function handleStatsRequest(blockGauge = false): Promise<Response> {
  try {
    const snap = await buildSnapshot(blockGauge);
    return new Response(JSON.stringify(snap, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
