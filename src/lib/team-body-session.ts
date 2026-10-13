/**
 * Home side of a team-body session page (team-project-TEAMVIS6): a member asks the center for a page of a card's session,
 * the home instance claims it (bridge/team-body-fetch.ts) and answers here. Order of checks, each before any file is read:
 * 1. the card is home here: an enabled mirror of this center feature, pushed under this instance's id, and the task is
 *    one of that feature's local tasks; otherwise gate_refused.
 * 2. teamBody is on for the card's local project; observe (or off) answers not_open.
 * 3. the cursor names a session the scheduler bound to this task; a forged sessionId answers gate_refused.
 * The page is read with session-history's own reader, main session only (never a subagent file), and every message goes
 * through scrubSessionPage. Only message text, reply text and tool summaries are sent: no attachments, files or buttons.
 * Cursor: `v1:<sessionId>:<seq|tail>`, opaque to the center; seq may carry the two decimals session-history-inbox.ts gives
 * messages taken through check_inbox (line + 0.01·k), so every cursor this file writes reads back. null = the newest page of the card's first session; a
 * session read to its start continues with the next one. tests/team-body-session.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import type { MirrorEntry } from "./shared-ledger-projector.js";
import type { HistoryMessage, HistoryPage } from "./session-history-types.js";
import { isValidSessionId } from "./session-history.js";
import { scrubSessionPage, TEAM_BODY_MASK, type TeamBodyScrub } from "./team-body-scrub.js";
import type { TeamBodyMode } from "./team-body-switch.js";
import {
  TEAM_BODY_BATCH_MAX_BYTES, TEAM_BODY_TEXT_MAX_BYTES, teamBodyDigest, type TeamBodyPageReturn, type TeamBodyRecord,
} from "./shared-ledger-contract-team-body.js";

type PageResult = TeamBodyPageReturn["result"];
/** One claimed request, as parseTeamBodyPageClaimed returns it. */
export interface SessionPageRequest { projectId: string; featureId: string; taskId: string; cursor: string | null; limit: number }
/** Where the claim came from: the team and the instance id the center knows us by. */
export interface ClaimScope { centerId: string; teamId: string; instanceId: string }
export interface CardSession { sessionId: string; agent: string }
export interface HomeCard { localProject: string; localTaskId: string; sessions: CardSession[] }

export interface SessionPageDeps {
  /** null = this card is not home here (or not for this scope). */
  card: (scope: ClaimScope, request: SessionPageRequest) => HomeCard | null;
  mode: (localProject: string) => TeamBodyMode;
  /** One page of a main session file, messages with seq < before (null = newest). null = the file is gone. */
  readPage: (session: CardSession, before: number | null, limit: number) => Promise<HistoryPage | null>;
  scrub: SharedLedgerScrubContext;
}

const REFUSED = { kind: "refused", code: "gate_refused" } as const satisfies PageResult;
const NOT_OPEN = { kind: "refused", code: "not_open" } as const satisfies PageResult;

interface Cursor { sessionId: string; before: number | null }
export const encodeCursor = (c: Cursor): string => `v1:${c.sessionId}:${c.before ?? "tail"}`;
export function decodeCursor(raw: string): Cursor | null {
  const m = /^v1:([^:]+):(tail|(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,2})?)$/.exec(raw);
  if (!m || !isValidSessionId(m[1]!)) return null;
  const before = m[2] === "tail" ? null : Number(m[2]);
  return before === null || before <= Number.MAX_SAFE_INTEGER ? { sessionId: m[1]!, before } : null;
}

/**
 * The live card lookup, given what the bridge reads: mirrors (shared-ledger-mirrors.json), this instance's service credential
 * id for a mirror, and the ledger. The center's taskId is the home sourceTaskId, as in every projection we push.
 */
export function homeCardOf(scope: ClaimScope, request: SessionPageRequest, mirrors: Record<string, MirrorEntry>,
  instanceOf: (entry: MirrorEntry) => string | null, db: Database): HomeCard | null {
  const hit = Object.entries(mirrors).find(([, e]) => e.enabled && e.centerId === scope.centerId && e.teamId === scope.teamId
    && e.projectId === request.projectId && e.centerFeatureId === request.featureId && e.sourceInstanceId === scope.instanceId);
  if (!hit) return null;
  const [localFeatureId, entry] = hit;
  if (instanceOf(entry) !== scope.instanceId) return null;
  const task = db.prepare("SELECT id, project, featureId FROM tasks WHERE id = ?").get(request.taskId) as
    { id: string; project: string; featureId: string | null } | null;
  if (!task || task.project !== entry.localProject) return null;
  if (task.featureId !== localFeatureId && !Object.hasOwn(entry.taskMeta, task.id)) return null;
  let rows: { agent: string; sessionId: string; role: string }[] = [];
  try {
    rows = db.prepare("SELECT agent, sessionId, role FROM scheduler_sessions WHERE taskId = ?").all(task.id) as typeof rows;
  } catch { /* a ledger without the scheduler tables has no bound sessions */ }
  // Author first, then the rest in a stable order.
  rows.sort((a, b) => Number(b.role === "author") - Number(a.role === "author") || a.sessionId.localeCompare(b.sessionId));
  const sessions = rows.filter((r) => isValidSessionId(r.sessionId)).map(({ agent, sessionId }) => ({ agent, sessionId }));
  return { localProject: entry.localProject, localTaskId: task.id, sessions };
}

const ROLE: Record<HistoryMessage["role"], string> = { user: "用户", assistant: "助手", system: "系统" };
const clean = (s: string): string => s.replaceAll("\0", "");
/** What of one message may leave: text and reply text; tool names and one-line summaries as a tool output. Nothing else. */
function partsOf(m: HistoryMessage): { text: string; tools: string } {
  const text = [m.text, m.replyText].filter((s): s is string => !!s?.trim()).map(clean).join("\n\n");
  const tools = (m.tools ?? []).map((t) => clean(`${t.name}: ${t.summary}`)).join("\n");
  return { text, tools };
}

function recordOf(request: SessionPageRequest, sessionId: string, m: HistoryMessage, scrub: SharedLedgerScrubContext): TeamBodyRecord | null {
  const { text, tools } = partsOf(m);
  if (!text && !tools) return null;
  const [main, tool] = scrubSessionPage([{ text }, { text: tools, tool: true }], scrub) as [TeamBodyScrub, TeamBodyScrub];
  // A refused part sends nothing of itself; the mask says something was there.
  const part = (s: TeamBodyScrub) => s.refused ? TEAM_BODY_MASK : s.text;
  let body = `[${ROLE[m.role]}]${text ? `\n${part(main)}` : ""}${tools ? `\n[工具]\n${part(tool)}` : ""}`;
  let masked = main.maskedSegments + tool.maskedSegments + Number(main.refused) + Number(tool.refused);
  if (Buffer.byteLength(body, "utf8") > TEAM_BODY_TEXT_MAX_BYTES) { body = `[${ROLE[m.role]}]\n${TEAM_BODY_MASK}`; masked++; }
  return {
    featureId: request.featureId, taskId: request.taskId, kind: "session-page", sourceKey: `${sessionId}:${m.seq}`, text: body,
    scrubVersion: main.scrubVersion, maskedSegments: masked, digest: teamBodyDigest(body),
  };
}

/** Never throws for a request it can judge; a reader error rejects and the caller refuses. */
export async function serveSessionPage(scope: ClaimScope, request: SessionPageRequest, deps: SessionPageDeps): Promise<PageResult> {
  const card = deps.card(scope, request);
  if (!card) return REFUSED;
  if (deps.mode(card.localProject) !== "on") return NOT_OPEN;
  let cursor: Cursor | null;
  if (request.cursor === null) cursor = card.sessions[0] ? { sessionId: card.sessions[0].sessionId, before: null } : null;
  else {
    cursor = decodeCursor(request.cursor);
    if (!cursor || !card.sessions.some((s) => s.sessionId === cursor!.sessionId)) return REFUSED;
  }
  if (!cursor) return { kind: "page", records: [], nextCursor: null };
  const index = card.sessions.findIndex((s) => s.sessionId === cursor!.sessionId);
  const session = card.sessions[index]!;
  const after = card.sessions[index + 1];
  const following = after ? encodeCursor({ sessionId: after.sessionId, before: null }) : null;
  const page = await deps.readPage(session, cursor.before, request.limit);
  if (!page || !page.messages.length) return { kind: "page", records: [], nextCursor: following };
  // Newest first until the batch budget is spent; the cursor then resumes before the oldest message that was sent.
  const records: TeamBodyRecord[] = [];
  let bytes = 0, oldest = page.messages[page.messages.length - 1]!.seq + 1, cut = false;
  for (let i = page.messages.length - 1; i >= 0; i--) {
    const m = page.messages[i]!;
    const r = recordOf(request, session.sessionId, m, deps.scrub);
    const size = r ? Buffer.byteLength(r.text, "utf8") : 0;
    if (bytes + size > TEAM_BODY_BATCH_MAX_BYTES) { cut = true; break; }
    if (r) records.unshift(r);
    bytes += size;
    oldest = m.seq;
  }
  const more = cut || page.hasMore;
  return { kind: "page", records, nextCursor: more ? encodeCursor({ sessionId: session.sessionId, before: oldest }) : following };
}
