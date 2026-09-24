/**
 * agents 列表里「当前模型 · 档位」的兜底链（顶栏徽章、切换器高亮都读它）。纯逻辑，单测在
 * tests/display-model.test.ts。三种运行时各走各的，不能混用：
 * - claude-code：刚切换的乐观值 → 会话实测（7 天内）→ registry 钉的（别名展开）→ 全局默认 → 陈旧实测
 * - pi：模型写法是 provider/id，不走 Claude Code 的别名表，也不落到 Claude Code 的全局默认；
 *   档位的实测常扫不到（只在会话头部写一次），靠扩展启动时的快照兜底
 * - codex：会话实测 → registry → config.toml → 模型目录的默认档；实测到「档位 null」就是模型默认档，
 *   同样不能落到 Claude Code 的全局 effort（那是另一套值）
 */
import type { SessionTailInfo } from "./session-tail.js";
import { codexDisplayDefaults, type CodexModel } from "./codex-catalog.js";

/** 会话实测超过这个时限视为陈旧：重启后一轮没跑过的 agent，老会话里的模型读数是老黄历 */
const READ_STALE_MS = 7 * 24 * 3600_000;

const freshOrNull = <T>(v: T | null | undefined, ts: number | null | undefined, now: number = Date.now()): T | null =>
  v != null && ts != null && now - ts < READ_STALE_MS ? v : null;

export interface DisplayInput {
  /** sourceFor(r?.runtime).id：claude-code / pi / codex */
  runtime: string;
  /** 刚切换、实测还没追上的乐观值 */
  override: { model: string | null; effort: string | null };
  tail: SessionTailInfo | null | undefined;
  reg: { model?: string; effort?: string } | undefined;
  /** ~/.claude/settings.json 的全局默认（只给 Claude Code 用） */
  claudeGlobal: { model: string | null; effort: string | null };
  /** Pi 扩展启动时写的运行快照里的思考档位 */
  piSnapThinking?: string | null;
  codex?: { catalog: CodexModel[] | null; config: { model: string | null; effort: string | null } };
  resolveAlias: (m: string) => string;
  now?: number;
}

export function displayModelEffort(i: DisplayInput): { model: string | null; effort: string | null } {
  const { override: ov, tail, reg } = i;
  const fresh = <T>(v: T | null | undefined, ts: number | null | undefined) => freshOrNull(v, ts, i.now);
  const model0 = ov.model ?? fresh(tail?.model, tail?.modelTs);
  const effort0 = ov.effort ?? fresh(tail?.effort, tail?.effortTs);
  if (i.runtime === "pi") {
    return {
      model: model0 ?? reg?.model ?? tail?.model ?? null,
      effort: ov.effort ?? tail?.effort ?? i.piSnapThinking ?? reg?.effort ?? null,
    };
  }
  if (i.runtime === "codex") {
    const model = model0 ?? reg?.model ?? null;
    const d = codexDisplayDefaults(i.codex?.catalog ?? null, i.codex?.config ?? { model: null, effort: null }, model);
    return { model: d.model ?? tail?.model ?? null, effort: effort0 ?? reg?.effort ?? d.effort ?? tail?.effort ?? null };
  }
  return {
    model: model0 ?? (reg?.model ? i.resolveAlias(reg.model) : null) ?? i.claudeGlobal.model ?? tail?.model ?? null,
    effort: effort0 ?? reg?.effort ?? i.claudeGlobal.effort ?? tail?.effort ?? null,
  };
}
