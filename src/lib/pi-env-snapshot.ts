/**
 * Pi 能力快照：把「这个会话实际加载了什么」落成 JSON（`manager pi-env`、网页端更新提示读它）。
 *
 * 记**实况**而不是配置：`--no-extensions` 到底关掉了什么，只有这里看得见。
 * 落文件（0600，和 registry 同目录家族）而不是发 bridge：bridge 挂了、会话死了之后仍要可读。
 *
 * 两条传输共用这一个写入器：
 *   - tmux：src/pi/claudestra-extension.ts 在 session_start / agent_start 调
 *   - acp ：src/lib/acp/pi-adapter/pi-env-snapshot.ts（那个 Pi 扩展）调
 * 分开写会漏 —— 网页的「Pi 新版本已装好，本会话还在 X，重启后生效」横幅读的就是这份快照
 * （src/lib/update-hints.ts 的 readPiRuntimeSnapshot），ACP 不写 ⇒ 重启后横幅永不消失。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 只用得到这几个查询方法（Pi 的扩展 API 子集，便于测试替身） */
interface PiSnapshotApi {
  getAllTools?(): Array<{ name?: string } | string>;
  getActiveTools?(): string[];
  getCommands?(): Array<{ name?: string } | string>;
  getModel?(): { id?: string; name?: string } | undefined;
  getThinkingLevel?(): string | undefined;
}

export interface PiSnapshotOptions {
  pi: PiSnapshotApi;
  /** agent 名（registry 里的 tmuxName，如 agent-foo）；空则什么都不写 */
  agent: string;
  sessionId?: string;
  ctx?: { model?: { id?: string; name?: string } };
  /** 本进程真实的 Pi 版本（写进快照的 piVersion；更新提示拿它和已装版本比） */
  piVersion?: string;
  /** 状态目录覆盖（测试用），缺省 ~/.claude-orchestrator */
  stateDir?: string;
  /** 时钟覆盖（测试用） */
  now?: () => Date;
}

const names = (list: Array<{ name?: string } | string> | undefined): string[] =>
  (list ?? [])
    .map((x) => (typeof x === "string" ? x : typeof x?.name === "string" ? x.name : ""))
    .filter(Boolean)
    .sort();

/** 写一份快照。任何失败都静默（快照写不了不该影响会话本身）。 */
export function writePiEnvSnapshot(o: PiSnapshotOptions): void {
  const agent = (o.agent || "").trim();
  if (!agent) return;
  try {
    const tools = names(o.pi.getAllTools?.());
    const commands = names(o.pi.getCommands?.());
    const model = o.ctx?.model ?? o.pi.getModel?.();
    const snap = {
      at: (o.now?.() ?? new Date()).toISOString(),
      agent,
      sessionId: o.sessionId || undefined,
      cwd: process.cwd(),
      piVersion: o.piVersion || undefined,
      toolCount: tools.length,
      tools,
      activeTools: (o.pi.getActiveTools?.() ?? []).slice().sort(),
      commandCount: commands.length,
      commands,
      model: model?.id || model?.name || undefined,
      thinking: (() => {
        try {
          return o.pi.getThinkingLevel?.();
        } catch {
          return undefined;
        }
      })(),
    };
    const dir = join(o.stateDir?.trim() || process.env.CLAUDESTRA_STATE_DIR?.trim() || join(homedir(), ".claude-orchestrator"), "pi-env");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${agent}.json`), JSON.stringify(snap, null, 1), { mode: 0o600 });
  } catch {
    /* 快照写不了不影响通道/会话本身：读它的人（pi-env 命令、更新提示）会按缺省处理 */
  }
}
