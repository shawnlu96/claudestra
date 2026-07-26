/**
 * v2.15+ 思考遥测：解析 Claude Code TUI 的 spinner 状态行。
 *
 * thinking 明文拿不到（订阅会话服务端 redact，2026-02 起），但状态行是公开的
 * 实时遥测：`✽ Hatching… (7s · ↓ 130 tokens · thinking with xhigh effort)`——
 * 耗时 / 输出 token 计数 / effort 都在。抓完整 thinking 不可靠（滚动即丢），
 * 这个状态行固定在输入框上方、单行、格式稳定，agent 忙时低频 capture 即可。
 *
 * 两个用途：
 * 1. web「思考中」徽章富化——token 在跳 = 模型活着，消除「卡住了」的错觉；
 * 2. 真卡死检测——token 计数长时间不动（StallTracker），比 wedge-watcher 的
 *    30 分钟 pane-diff 阈值灵敏得多。
 *
 * 纯逻辑，不碰 tmux——采样由 bridge 侧注入，方便单测。
 */

export interface ThinkingStatus {
  /** 已进行秒数（"3m 12s" → 192）；解析不出为 null */
  elapsedSec: number | null;
  /** 原始耗时串（"3m 12s"），展示用 */
  elapsedRaw: string | null;
  /** ↓ 输出 token 计数（"2.1k" → 2100）；还没开始出 token 时为 null */
  tokens: number | null;
  /** "thinking with xhigh effort" 里的档位；不在思考深水区时为 null */
  effort: string | null;
  /** spinner 动词（Hatching/Crunching/…），纯装饰但前端可显示 */
  verb: string | null;
}

/** "3m 12s" / "45s" / "1h 2m 3s" → 秒数 */
function parseElapsed(s: string): number | null {
  const m = s.match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (parseInt(m[1] || "0") * 3600) + (parseInt(m[2] || "0") * 60) + parseInt(m[3] || "0");
}

/** "130" / "2.1k" → 数值 */
function parseTokenCount(s: string): number | null {
  const m = s.match(/^([\d.]+)(k?)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2] ? n * 1000 : n);
}

/**
 * 从 pane 文本里找 spinner 状态行并解析。找不到（不在回合中 / TUI 被别的
 * modal 盖住）返回 null。自底向上找——状态行贴着输入框，永远在可视区下部。
 *
 * 已见过的形态：
 *   `✳ Hatching…`                                       （刚起步，无括号）
 *   `✽ Hatching… (5s · thinking with xhigh effort)`
 *   `✢ Hatching… (7s · ↓ 130 tokens · thought for 1s)`
 *   `✻ Crunching… (3m 12s · ↓ 2.1k tokens · esc to interrupt)`
 * 完成态（`✻ Brewed for 9s`）没有省略号+括号，不会被误认。
 */
export function parseThinkingStatus(pane: string): ThinkingStatus | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // spinner 字符集是一组旋转的星号变体,不枚举具体字形:非字母数字的单字符
    // 开头 + 一个词 + …(或 U+2026) 即认。括号可缺（刚起步）。
    const m = line.match(/^([^\w\s])\s+([A-Za-z][\w'-]*)(?:…|\.\.\.)\s*(?:\((.*)\))?\s*$/);
    if (!m) continue;
    const verb = m[2];
    const detail = m[3] ?? "";
    const st: ThinkingStatus = { elapsedSec: null, elapsedRaw: null, tokens: null, effort: null, verb };
    for (const rawPart of detail.split("·")) {
      const part = rawPart.trim();
      if (!part) continue;
      if (/^(?:\d+h\s*)?(?:\d+m\s*)?\d+s$/.test(part)) {
        st.elapsedRaw = part;
        st.elapsedSec = parseElapsed(part);
        continue;
      }
      const tok = part.match(/^[↓⇣]\s*([\d.]+k?)\s*tokens?$/i);
      if (tok) {
        st.tokens = parseTokenCount(tok[1]);
        continue;
      }
      const eff = part.match(/thinking with (\w+) effort/);
      if (eff) st.effort = eff[1];
      // "thought for 1s" / "esc to interrupt" 等其余片段:不需要,忽略
    }
    return st;
  }
  return null;
}

/**
 * 卡死判定：**已开始出 token**（↓ 在场）且计数 stallMs 内纹丝不动 → stalled。
 *
 * 为什么只看 token 而不看耗时：spinner 的计时器是 TUI 本地渲染的，网络挂死时
 * 照样在走——耗时在涨不代表活着。为什么 token 为 null 不算：纯思考阶段
 * （"thinking with xhigh effort"、还没有 ↓）可以合法地持续好几分钟，这段的
 * 兜底仍归 wedge-watcher 的 30 分钟粗筛管。
 *
 * 每个 stall 事件只报一次（alerted 标记），token 恢复跳动 / 回合结束即复位。
 */
export class StallTracker {
  private m = new Map<string, { tokens: number; since: number; alerted: boolean }>();

  constructor(private readonly stallMs = 8 * 60_000) {}

  /**
   * 喂一次采样。返回 true = 刚确认进入 stalled（调用方应告警一次）。
   * st 为 null（没在思考）或 tokens 为 null（纯思考阶段）都会清掉基线。
   */
  sample(agent: string, st: ThinkingStatus | null, now = Date.now()): boolean {
    if (!st || st.tokens === null) {
      this.m.delete(agent);
      return false;
    }
    const rec = this.m.get(agent);
    if (!rec || rec.tokens !== st.tokens) {
      this.m.set(agent, { tokens: st.tokens, since: now, alerted: false });
      return false;
    }
    if (!rec.alerted && now - rec.since >= this.stallMs) {
      rec.alerted = true;
      return true;
    }
    return false;
  }

  /** 该 agent 当前冻结了多久（ms）；没有基线返回 0。告警文案用。 */
  frozenFor(agent: string, now = Date.now()): number {
    const rec = this.m.get(agent);
    return rec ? now - rec.since : 0;
  }

  clear(agent: string): void {
    this.m.delete(agent);
  }
}
