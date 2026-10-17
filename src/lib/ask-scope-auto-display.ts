import { ASK_SCOPE_RULE } from "./ask-scope-auto.js";
import type { RecoveryMode } from "./recovery-policy.js";
import { scopeRegistryVariant, scopeWireProtected } from "./ask-scope-registry.js";

interface ApprovedFile { path: string; kind: string; added: number | null; deleted: number | null; granted: boolean }
interface ScopeEvidence { rule: string; caseFold?: RecoveryMode; files: ApprovedFile[] }
const label = (file: ApprovedFile) => file.kind === "wire" ? "小接线" : "登记项";
const lineFor = (file: ApprovedFile) => `${JSON.stringify(file.path)}：` + (file.added === null || file.deleted === null
  ? "二进制，行数不适用" : `+${file.added} / -${file.deleted}（${file.added + file.deleted} 行）`);

interface TestScopeFile { path: string; askId: string; added: number | null; deleted: number | null; removedBlocks: number | null; over: boolean; reason: string | null }
export const TEST_SCOPE_HEADER = "已自动核准（测试类扩围·被规格替代的旧断言）：";
const TEST_SCOPE_MARK = "🔴 ";

/**
 * ASKSCOPE3：经测试类扩围批进来、交付超出尺寸的测试文件标红列在「已自动核准」小节（order-ask-test-scope-size.ts 核的事实）。
 * 登记时与出单时各调一次：先抹掉上次加的这一节再按事件数据重写，不重复。
 */
function withTestScope(text: string, data: Record<string, unknown>): string {
  const files = (data.askScopeTests as { files?: TestScopeFile[] } | undefined)?.files;
  const lines = text.split("\n").filter((l) => l !== TEST_SCOPE_HEADER && !l.startsWith(TEST_SCOPE_MARK));
  const over = Array.isArray(files) ? files.filter((f) => f.over) : [];
  if (!over.length) return lines.join("\n");
  return [...lines, TEST_SCOPE_HEADER, ...over.map((f) => `${TEST_SCOPE_MARK}${lineFor({ ...f, kind: "tests", granted: true })}；ask ${f.askId}；`
    + `删掉 test / describe 块 ${f.removedBlocks ?? "未核"} 个；${f.reason ?? ""}——规格外尺寸超限，审查员判`)].join("\n");
}

/** Persist facts with a historical note; review rendering uses the current policy, never the delivery-time mode. */
export function describeDeliveredScope(text: string, data: Record<string, unknown>, mode?: RecoveryMode, caseFold?: RecoveryMode): string {
  return withTestScope(describeAutoScope(text, data, mode, caseFold), data);
}

function describeAutoScope(text: string, data: Record<string, unknown>, mode?: RecoveryMode, caseFold?: RecoveryMode): string {
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
  const authorized: string[] = [], outside: string[] = [];
  for (const line of lines) {
    const file = approved.find((f) => line.startsWith(`${JSON.stringify(f.path)}：`));
    if (!file) { outside.push(line); continue; }
    // Only case variants become newly protected; exact registry grants retain their diff verdict.
    const folded = file.path.toLowerCase();
    if (caseFold === "on" && evidence.caseFold !== "on" && folded !== file.path
      && (scopeWireProtected(folded) || scopeRegistryVariant(file.path))) outside.push(`${line}；折叠口径收紧后需人工核`);
    else authorized.push(`${line}；${label(file)}`);
  }
  return (authorized.length ? [...outside, "已自动核准：", ...authorized] : outside).join("\n");
}
