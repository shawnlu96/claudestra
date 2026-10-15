import { ASK_SCOPE_RULE } from "./ask-scope-auto.js";
import type { RecoveryMode } from "./recovery-policy.js";

interface ApprovedFile { path: string; kind: string; added: number | null; deleted: number | null; granted: boolean }
interface ScopeEvidence { rule: string; files: ApprovedFile[] }
const label = (file: ApprovedFile) => file.kind === "wire" ? "小接线" : "登记项";
const lineFor = (file: ApprovedFile) => `${JSON.stringify(file.path)}：` + (file.added === null || file.deleted === null
  ? "二进制，行数不适用" : `+${file.added} / -${file.deleted}（${file.added + file.deleted} 行）`);

/** Persist facts with a historical note; review rendering uses the current policy, never the delivery-time mode. */
export function describeDeliveredScope(text: string, data: Record<string, unknown>, mode?: RecoveryMode): string {
  const evidence = data.askScopeAuto as ScopeEvidence | undefined;
  if (!evidence || !Array.isArray(evidence.files)) return text;
  const approved = evidence.files.filter((file) => file.granted);
  if (mode === undefined) return approved.length ? `${text}\n已自动核准:${approved.map((f) => `${f.path}(${label(f)})`).join("、")}` : text;
  const lines = text.split("\n").filter((line) => !line.startsWith("已自动核准:"));
  // Older events removed granted files. Recover their recorded counts so rollback also remains visible after an upgrade.
  for (const file of approved) {
    if (!lines.some((line) => line.startsWith(`${JSON.stringify(file.path)}：`))) lines.push(lineFor(file));
  }
  if (approved.length && lines[0] === "规格外文件：无（相对 PR base）") lines[0] = "规格外文件（相对 PR base）：";
  if (mode !== "on" || evidence.rule !== ASK_SCOPE_RULE || !approved.length) return lines.join("\n");
  const authorized: string[] = [];
  const outside = lines.filter((line) => {
    const file = approved.find((f) => line.startsWith(`${JSON.stringify(f.path)}：`));
    if (!file) return true;
    authorized.push(`${line}；${label(file)}`);
    return false;
  });
  return [...outside, "已自动核准：", ...authorized].join("\n");
}
