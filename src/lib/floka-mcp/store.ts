/**
 * 会话 → MCP 命名族的落盘（rename.mcp）。根目录 <state>/mcp-family/：
 *   sessions/<会话 id>.json  {family, agent, at}  只记新族；没有文件 = 旧族（rename.mcp 打开前的会话都没有）
 * 会话 id 启动前未知的新族启动由 launch.ts 先取 id 钉住，所以只有按会话的记录，没有按 agent 的。
 * 一会话一个文件：并发启动不同 agent 不抢同一份文件，没有读改写窗口。observe 报告另放 <state>/mcp-family-observe/，
 * 不算「用过新族」（hasFamilyRecords 只看 sessions，bridge 据它决定是否认新族前缀）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "../paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "../state-file.js";
import { isSettingsAgentName } from "../agent-settings.js";
import { isMcpFamily, type McpFamily } from "./families.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultFamilyRoot = (): string => statePath("mcp-family");
const defaultObserveRoot = (): string => statePath("mcp-family-observe");

const sessionFile = (root: string, id: string): string | null => (UUID_RE.test(id) ? join(root, "sessions", `${id}.json`) : null);

const familyIn = (v: unknown): boolean => !!v && typeof v === "object" && isMcpFamily((v as { family?: unknown }).family);

/** 读一条：不存在 → null；坏文件报一次并按 null（= 旧族，最保守：不会把旧会话换成新名） */
function readFamily(path: string | null): McpFamily | null {
  if (!path) return null;
  const r = readJsonStateSync(path, familyIn);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "mcp-family");
  return r.status === "ok" ? (r.data as { family: McpFamily }).family : null;
}

export const readSessionFamily = (sessionId: string | undefined, root = defaultFamilyRoot()): McpFamily | null =>
  sessionId ? readFamily(sessionFile(root, sessionId)) : null;

/** 写会话记录；id 不像会话 id 就抛（调用方据此退回旧族，不能起了新名却没记下） */
export function writeSessionFamily(sessionId: string, family: McpFamily, agent: string | undefined, root = defaultFamilyRoot(), now = Date.now()): void {
  const path = sessionFile(root, sessionId);
  if (!path) throw new Error(`会话 id 不合法：${JSON.stringify(sessionId)}`);
  writeJsonAtomicSync(path, { family, agent: agent ?? null, at: new Date(now).toISOString() }, { trailingNewline: true });
}

/** observe 报告：每个 agent 一份最近一次（覆盖写），只有名字和来源，不含配置值 */
export function writeObserveReport(agent: string, report: Record<string, unknown>, root = defaultObserveRoot(), now = Date.now()): void {
  if (!isSettingsAgentName(agent)) return;
  writeJsonAtomicSync(join(root, `${agent}.json`), { at: new Date(now).toISOString(), agent, ...report }, { trailingNewline: true });
}

/** 有没有任何会话按新族起过：没有 = 新族前缀在本机还没出现过 */
export function hasFamilyRecords(root = defaultFamilyRoot()): boolean {
  return existsSync(join(root, "sessions"));
}
