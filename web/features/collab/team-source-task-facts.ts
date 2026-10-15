/** Optional sub-DAG decorations: independent of detail reads and their rate-limit backoff. */
import { identityKey, type FeatureList, type SharedLedgerSession } from "@/lib/api/shared-ledger";
import { SharedLedgerReads, sharedLedgerReadsTransport, type TaskFact } from "@/lib/api/shared-ledger-reads";
import type { BoardNode, NodePhase } from "./dag/dag-types";

export function nodeFacts(fact: TaskFact | null | undefined, phase: NodePhase): Partial<Pick<BoardNode, "since" | "lastEvent" | "doneAt">> {
  if (!fact) return {};
  if (phase === "done") return fact.doneAt === null ? {} : { doneAt: fact.doneAt };
  if (phase !== "active" || fact.doneAt !== null) return {};
  return { ...(fact.stageSince === null ? {} : { since: fact.stageSince }),
    ...(fact.lastEvent === null ? {} : { lastEvent: { at: fact.lastEvent.at, actor: "", kind: fact.lastEvent.kind, text: "" } }) };
}

type FactsOverride = Pick<SharedLedgerReads, "taskFacts">;
interface Entry {
  at: number;
  water: number | undefined;
  busy: boolean;
  facts: ReadonlyMap<string, TaskFact> | null;
}
const watermark = (list: FeatureList | undefined, id: string) => {
  const feature = list?.features.find(f => f.id === id);
  return feature ? feature.projection?.sourceSeq ?? feature.updatedAt : undefined;
};

/** Results and request watermarks belong to the captured identity, including responses arriving after a switch. */
export function teamTaskFacts(session: SharedLedgerSession, onChange: () => void, override?: FactsOverride) {
  const entries = new Map<string, Entry>(), lists = new Map<string, FeatureList>();
  let opened: string | null = null;
  const key = (identity: string, id: string) => JSON.stringify([identity, id]);
  const read = (id: string) => {
    const identity = { ...session.identity }, owner = identityKey(identity), k = key(owner, id);
    const old = entries.get(k);
    if (old?.busy) return;
    const entry: Entry = { at: Date.now(), water: watermark(lists.get(owner), id), busy: true, facts: old?.facts ?? null };
    entries.set(k, entry);
    const reads = override ?? new SharedLedgerReads(identity, sharedLedgerReadsTransport({ fp: identity.machine }, identity.project));
    void reads.taskFacts(id, new AbortController().signal).then(result => {
      if (result !== null) {
        entry.facts = new Map(result.tasks.map(fact => [fact.taskId, fact]));
        onChange();
      }
    }).catch(error => {
      // The production reader returns null for all non-abort failures; an injected reader can still reject. Keep the previous decorations.
      console.warn(`[team] task-facts read failed: ${String(error)}`);
    }).finally(() => { entry.busy = false; });
  };
  return {
    open(id: string | null) {
      opened = id;
      if (id && !entries.has(key(identityKey(session.identity), id))) read(id);
    },
    board(list: FeatureList) {
      const owner = identityKey(session.identity);
      lists.set(owner, list);
      if (opened) {
        const entry = entries.get(key(owner, opened)), water = watermark(list, opened);
        // focus may precede the first board: associate that initial request with its first observed watermark.
        if (entry && entry.water === undefined) entry.water = water;
        if (!entry || (!entry.busy && entry.water !== water && Date.now() - entry.at >= 30_000)) read(opened);
      }
      return (id: string): ReadonlyMap<string, TaskFact> | null => entries.get(key(identityKey(session.identity), id))?.facts ?? null;
    },
  };
}
