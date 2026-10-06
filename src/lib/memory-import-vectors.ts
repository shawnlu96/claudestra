/** Optional semantic checks compute vectors outside the import transaction, without creating or updating the vector cache. */
import type { Database } from "bun:sqlite";
import { embedTexts, type Embedder } from "./memory-embed.js";
import { getMemory, memoryState } from "./ledger-memory.js";
import { importVectorKey, type ImportPlan, type ImportVectors } from "./memory-import.js";
import { vectorSource } from "./memory-vectors.js";

export async function importVectors(db: Database, plan: ImportPlan, embedder: Embedder | null): Promise<ImportVectors> {
  const out = new Map<string, Float32Array>();
  if (!embedder) return out;
  const existing = (db.query("SELECT id FROM memories WHERE project = ?").all(plan.project) as { id: string }[])
    .filter(({ id }) => !["retracted", "superseded"].includes(memoryState(db, id)!.status)).map(({ id }) => getMemory(db, id)!);
  const memories = [...new Map([...existing, ...plan.rows.map((r) => r.memory)].map((m) => [importVectorKey(m), m])).values()];
  for (let i = 0; i < memories.length; i += 16) {
    const batch = memories.slice(i, i + 16);
    const vecs = await embedTexts(embedder, batch.map(vectorSource));
    batch.forEach((m, k) => { if (vecs[k]) out.set(importVectorKey(m), vecs[k]!); });
  }
  return out;
}
