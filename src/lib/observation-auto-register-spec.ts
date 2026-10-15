/** Structured spec authorization shared by registration and due-time revalidation. */
import { createHash } from "node:crypto";
import { statePath } from "./paths.js";
import { postVerifySection, readPostVerifySpec } from "./scheduler-post-verify-ledger.js";

interface ObservationSpec { text: string }
export type ObservationSpecReader = (taskId: string) => ObservationSpec | null;
export const observationSpecPath = (id: string): string => statePath("ledger", "docs", "tasks", `${id}.md`);
export const specDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
export const observationSpecReader: ObservationSpecReader = readPostVerifySpec;

const marker = (line: string): string[] | null => {
  const m = /^自动转正\s*[:：]\s*([A-Za-z]\w*(?:\s*、\s*[A-Za-z]\w*)*)$/.exec(line.trim());
  return m ? m[1].split(/\s*、\s*/) : null;
};
const legacyKey = (line: string, project: string): string | null => {
  const clean = line.trim().replace(/^[-*+]\s+/, "").replace(/^`(.*)`$/, "$1");
  const m = /^(?:ledger\s+)?scheduler-recovery\s+(\S+)\s+on\s+--key\s+([A-Za-z]\w*)(?:\s+--reason\s+(?:"[^"]*"|'[^']*'|[^\s;&|`]+))?$/.exec(clean);
  return m?.[1] === project ? m[2] : null;
};

/** Only complete structured lines count; Chinese prose never grants configuration authority. */
export function automaticKeys(section: string, project: string): string[] {
  return [...new Set(section.split(/\r?\n/).flatMap((line) => marker(line) ?? (legacyKey(line, project) ? [legacyKey(line, project)!] : [])))];
}

/** Extra prose, checkboxes or headings keep the PM's post-verify work open. */
export function onlyAutomaticWork(text: string, project: string): boolean {
  const section = postVerifySection(text);
  if (!section || !automaticKeys(section, project).length) return false;
  const lines = section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(1).every((line) => marker(line) !== null || legacyKey(line, project) !== null || /^(`{3,}|~{3,})(?:sh|bash|shell)?$/.test(line));
}
