/**
 * `mission` 命令族（Autopilot，原名「值守」，lib/missions.ts；`autopilot` 是同一组命令的别名）：
 *   mission start <agent> --until <HH:MM|+3h|ISO> --goal "<目标>" [--ledger <路径>]
 *   mission stop <agent>                 人手动收回
 *   mission done <agent> ["<总结>"]      agent 自己宣告做完（Autopilot 提醒里写着这条）
 *   mission list
 *   mission log <agent> [-n <条数>]      最近几轮 run 的日志（lib/autopilot-log.ts）：推进了没有、发现了什么、为什么没执行
 * bridge 监听 missions.json，开了之后 agent 空闲就会收到第一句提醒。
 */
import { formatRunLine, readRunLog } from "../lib/autopilot-log.js";
import { missionKey, newMission, parseUntil, readMissions, updateMissions } from "../lib/missions.js";
import { extractStringFlag, loadRegistry, output } from "./core.js";

async function agentExists(agent: string): Promise<boolean> {
  if (agent === "master") return true;
  const reg = await loadRegistry();
  return !!(reg.agents[`agent-${agent}`] || reg.agents[agent]);
}

async function start(args: string[]): Promise<void> {
  let rest = args;
  const u = extractStringFlag(rest, "--until");
  rest = u.rest;
  const g = extractStringFlag(rest, "--goal");
  rest = g.rest;
  const l = extractStringFlag(rest, "--ledger");
  rest = l.rest;
  const agent = missionKey(rest[0] || "");
  const goal = (g.value ?? rest.slice(1).join(" ")).trim();
  if (!agent || !goal || !u.value) return output({ ok: false, error: 'mission start <agent> --until <HH:MM|+3h|ISO> --goal "<目标>" [--ledger <路径>]' });
  const until = parseUntil(u.value);
  if (!until) return output({ ok: false, error: `截止时间「${u.value}」看不懂或不在未来 7 天内（例：11:00、+3h、2026-09-28T11:00:00+09:00）` });
  if (!(await agentExists(agent))) return output({ ok: false, error: `agent "${agent}" 不存在` });
  const m = newMission({ agent, goal, until, ledger: l.value });
  await updateMissions((all) => void (all[agent] = m));
  output({ ok: true, mission: m });
}

async function finish(agent: string, status: "done" | "stopped", summary: string): Promise<void> {
  const key = missionKey(agent);
  if (!key) return output({ ok: false, error: `mission ${status === "done" ? "done" : "stop"} <agent>` });
  const hit = await updateMissions((all) => {
    const cur = all[key];
    if (!cur || cur.status !== "active") return null;
    Object.assign(cur, { status, finishedAt: new Date().toISOString(), ...(summary ? { summary } : {}) });
    delete cur.resumeAt;
    return { ...cur };
  });
  output(hit ? { ok: true, mission: hit } : { ok: false, error: `${key} 没有进行中的 Autopilot` });
}

/** 日志跟着 mission 的 id 走：进行中的、或刚结束的那一代；更早的几代文件还在 ~/.claude-orchestrator/autopilot/ 下 */
async function log(args: string[]): Promise<void> {
  const n = extractStringFlag(args, "-n");
  const key = missionKey(n.rest[0] || "");
  if (!key) return output({ ok: false, error: "mission log <agent> [-n <条数>]" });
  const m = (await readMissions())[key];
  if (!m?.id) return output({ ok: false, error: `${key} 没有 Autopilot 记录` });
  const lines = readRunLog(m.id, Math.max(1, Number(n.value) || 20));
  output({ ok: true, agent: key, missionId: m.id, status: m.status, lines: lines.map(formatRunLine), raw: lines });
}

export async function cmdMission(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "start") return start(rest);
  if (sub === "stop") return finish(rest[0] || "", "stopped", "");
  if (sub === "done") return finish(rest[0] || "", "done", rest.slice(1).join(" ").trim());
  if (sub === "list" || !sub) {
    const all = Object.values(await readMissions()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return output({ ok: true, missions: all });
  }
  if (sub === "log") return log(rest);
  output({ ok: false, error: "mission start|stop|done|list|log（autopilot 同义）" });
}
