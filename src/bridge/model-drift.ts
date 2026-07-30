/**
 * v2.16+ 模型漂移告警（owner 拍板 2026-07-30，外部用户报「莫名其妙被切到
 * Sonnet 4.6」后立项）。
 *
 * Claude Code 的用量保护会**静默**把会话降级到小模型（Max 计划 → Opus 4.8，
 * Pro 计划 → Sonnet 4.6），用户毫无感知。本 watcher 每 5 分钟比对：
 * - 钉定模型的 agent：jsonl 实测 model id ≠ registry 钉定（精确比对——
 *   opus-5 → opus-4-8 这种同家族降级正是 2026-07-29 的实锚事故）
 * - 未钉定的 agent：实测家族 ≠ 全局 settings.json 模型家族（粗粒度，
 *   避免全局默认换版本时的误报噪音；正好覆盖 Pro 用户 opus→sonnet 场景）
 * 命中 → Discord 频道告警 + session_anomaly(kind=model_drift) SSE（web 可见）。
 * 按 agent+实测模型 dedup；实测须新鲜（30 分钟内有回合）才参与，防止拿
 * 重启前的陈旧记录误报。
 */

import { readRegistryAgents } from "../lib/registry.js";
import { projectJsonlPath } from "../lib/jsonl-cost.js";
import { resolveModelAlias } from "../lib/claude-launch.js";
import { sessionTailInfo } from "./api-routes.js";
import { emitEvent } from "./event-bus.js";
import { modelFamilies } from "./permission-watcher.js";

const CHECK_INTERVAL_MS = 5 * 60_000;
const MEASURED_FRESH_MS = 30 * 60_000;

// agent → 已告警过的实测模型（同一漂移只报一次；回到预期后清除，可再触发）
const alerted = new Map<string, string>();

async function readGlobalModel(): Promise<string | null> {
  try {
    const s = JSON.parse(await Bun.file(`${process.env.HOME}/.claude/settings.json`).text());
    return typeof s.model === "string" ? s.model : null;
  } catch {
    return null;
  }
}

export function startModelDriftWatcher(
  notify: (channelId: string, text: string) => void
) {
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const gModel = await readGlobalModel();
      const gFamily = gModel ? [...modelFamilies(resolveModelAlias(gModel))][0] ?? null : null;
      for (const r of await readRegistryAgents()) {
        if (r.status !== "active" || !r.cwd || !r.sessionId || !r.channelId) continue;
        const info = await sessionTailInfo(projectJsonlPath(r.cwd, r.sessionId));
        if (!info?.model || !info.modelTs) continue;
        if (Date.now() - info.modelTs > MEASURED_FRESH_MS) continue;

        let expected: string | null = null;
        let drifted = false;
        if (r.model) {
          expected = resolveModelAlias(r.model);
          drifted = info.model !== expected;
        } else if (gFamily) {
          expected = gModel;
          const fam = [...modelFamilies(info.model)][0] ?? null;
          drifted = fam !== null && fam !== gFamily;
        }

        if (!drifted) {
          alerted.delete(r.name);
          continue;
        }
        if (alerted.get(r.name) === info.model) continue;
        alerted.set(r.name, info.model);
        console.log(`⚠️ 模型漂移 agent=${r.name} expected=${expected} actual=${info.model}`);
        emitEvent({
          agent: r.name,
          chatId: r.channelId,
          type: "session_anomaly",
          data: { kind: "model_drift", expected, actual: info.model, pinned: !!r.model },
        });
        notify(
          r.channelId,
          `⚠️ **${r.name}** 模型漂移：${r.model ? `钉定 \`${expected}\`` : `全局默认 \`${expected}\``}，实际在用 \`${info.model}\`。` +
            `多半是 Claude Code 用量保护静默降级。要拉回可 restart（钉定模型会随启动 flag 恢复），或显式钉模型防再犯。`
        );
      }
    } catch {
      /* 单轮失败不致命 */
    } finally {
      ticking = false;
    }
  }, CHECK_INTERVAL_MS);
  console.log(`🎛 模型漂移 watcher 启动 (每 ${CHECK_INTERVAL_MS / 60000} 分钟)`);
}
