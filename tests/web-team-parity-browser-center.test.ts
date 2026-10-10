import type { HomeFixture } from "@/features/collab/shared/home-fixture-gen";
import type { FeatureDetail, FeatureList } from "@/lib/api/shared-ledger";
import { canonicalJson } from "../src/lib/canonical-json.ts";
import { parityResponses } from "./shared-ledger-migration-http-fixture.ts";

export interface TeamFromHome { list: FeatureList; details: FeatureDetail[]; localFeature: Record<string, string> }
interface Snapshot { authorityMode: "planning" | "source"; home: HomeFixture; team: TeamFromHome }

/** The same pinned protocol fixture feeds browser consumers and private center input/output replay. */
export async function teamFromHome(home: HomeFixture, opts: { authorityMode?: "planning" | "source" } = {}): Promise<TeamFromHome> {
  const rows = parityResponses() as Snapshot[];
  const row = rows.find(row => row.authorityMode === (opts.authorityMode ?? "planning"));
  if (!row || canonicalJson(row.home) !== canonicalJson(home)) throw new Error("unsupported parity fixture input");
  return structuredClone(row.team);
}
