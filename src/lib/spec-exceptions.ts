/**
 * 规格「精准例外」机读（ASKDEF1）：不进 fileGlobs、PM 在规格里点名允许改的文件与限制。认两种写法：
 * - 独立一节 `## 精准例外`：每行一条（可带列表符号），一行写文件路径 + 限制说明；
 * - 现有写法：`## 范围…` 节内以「精准例外」开头的段落，冒号后按顶层分号（括号里的不算）拆成多条。
 * 文件路径只认反引号里的或行内的仓库相对路径：不认通配、绝对路径、. / .. 段；一条里没有路径（或只有通配）记进 errors。
 * 纯函数，不读文件。order-ask.ts（scope 提问命中即自动答）、spec-lint.ts（非阻断检查）用。tests/spec-exceptions.test.ts。
 */

interface SpecException { file: string; limit: string }
interface SpecExceptionError { line: number; text: string; why: string }
export interface SpecExceptions { entries: SpecException[]; errors: SpecExceptionError[] }

const SECTION = "精准例外";
const GLOB = /[*?[\]{}]/;
/** 反引号里的路径：带 / 或常见文件扩展名（`askDefaultAll`、`SweepDeps.notify` 这类标识符不算） */
const FILE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|toml|css|scss|html|sh|txt|lock|sql|py|go|rs)$/;
/** 行内不带反引号的候选：路径字符连成的一段，要带 /（根目录文件请写进反引号） */
const BARE_TOKEN = /[A-Za-z0-9_.@+*?{}[\]\/-]+/g;

const isRepoPath = (p: string): boolean =>
  !!p && !p.startsWith("/") && !p.includes("\\") && !/\s/.test(p) && !p.split("/").some((s) => !s || s === "." || s === "..");
const looksLikePath = (p: string): boolean => p.includes("/") || FILE_EXT.test(p);

/** 一条（一行或一个分号片段）里的路径；有通配的单列出来报错 */
function pathsOf(entry: string): { files: string[]; globs: string[] } {
  const files: string[] = [], globs: string[] = [];
  const take = (p: string) => {
    const s = p.trim().replace(/[.,;:)]+$/, "");
    if (!looksLikePath(s)) return;
    if (GLOB.test(s)) globs.push(s);
    else if (isRepoPath(s) && !files.includes(s)) files.push(s);
  };
  const rest = entry.replace(/`([^`\n]+)`/g, (_, p: string) => (take(p), " "));
  for (const m of rest.matchAll(BARE_TOKEN)) if (m[0].includes("/")) take(m[0]);
  return { files, globs };
}

/** 顶层分号拆分：括号（半角 / 全角）里的分号不拆 */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "（") depth++;
    else if ((ch === ")" || ch === "）") && depth > 0) depth--;
    if (depth === 0 && (ch === ";" || ch === "；")) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const stripBullet = (l: string): string => l.replace(/^\s*(?:[-*+]|\d+[.、)])\s+/, "").trim();
const heading = (l: string): RegExpMatchArray | null => l.match(/^(#{1,6})\s+(.*?)\s*$/);

function addEntry(out: SpecExceptions, line: number, text: string): void {
  const { files, globs } = pathsOf(text);
  for (const g of globs) out.errors.push({ line, text, why: `不认通配：${g}` });
  if (!files.length) {
    if (!globs.length) out.errors.push({ line, text, why: "没有仓库相对文件路径" });
    return;
  }
  for (const file of files) if (!out.entries.some((e) => e.file === file && e.limit === text)) out.entries.push({ file, limit: text });
}

export function parseSpecExceptions(text: string): SpecExceptions {
  const out: SpecExceptions = { entries: [], errors: [] };
  const lines = text.split(/\r?\n/);
  let section: "exceptions" | "scope" | null = null;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const h = heading(raw);
    if (h && h[1].length <= 2) {
      section = h[1].length === 2 && h[2] === SECTION ? "exceptions" : h[1].length === 2 && h[2].startsWith("范围") ? "scope" : null;
      continue;
    }
    if (!section || h || !raw.trim()) continue;
    const l = stripBullet(raw);
    if (section === "exceptions") { addEntry(out, i + 1, l); continue; }
    if (!l.startsWith(SECTION)) continue;
    // 段落：连着的非空行拼成一段
    let para = l;
    while (i + 1 < lines.length && lines[i + 1].trim() && !heading(lines[i + 1]) && !/^\s*(?:[-*+]|\d+[.、)])\s+/.test(lines[i + 1])) para += lines[++i].trim();
    const body = para.replace(/^精准例外\s*(?:[(（][^)）]*[)）])?\s*[:：]?/, "");
    for (const part of splitTop(body)) addEntry(out, i + 1, part);
  }
  return out;
}

/** files 全部是规格精准例外里点名的文件（空 = 不算命中） */
export const allExcepted = (ex: SpecExceptions, files: readonly string[]): boolean =>
  files.length > 0 && files.every((f) => ex.entries.some((e) => e.file === f));
