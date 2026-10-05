/**
 * 后台 shell 的输出目录跟着 CC 进程走、不跟会话：原生 /clear 轮转后，新开的 shell 仍写进进程启动时那个会话的 tasks/。
 * 只按 registry 里的 sessionId 拼目录会漏掉它们，所以从主会话 jsonl 里 CC 自己落的启动结果找目录：只认带结构化字段
 * toolUseResult.backgroundTaskId、且报的路径正是 `<slug>/<会话段>/tasks/<该 id>.output` 的记录——正文里引用的同款句子不算。
 * 只取会话段、由调用方按自己的根目录拼回：同一个文件不会因 /tmp 与 /private/tmp 两种写法被当成两个，也列不到根外的目录。
 * 同一批记录里的任务 id 也是权威的「真后台」确认（tests/bg-shell-dirs.test.ts、tests/bg-activity-rotation.test.ts）。
 */
import { stat } from "fs/promises";

const OUT_RE = /Output is being written to: (\S+)\.output/;
const SEG_RE = /^[\w-]+$/;
/** 首次读只看尾部这么多字节，与真 bg 确认（isRealBgTask）同口径 */
const TAIL_BYTES = 512_000;

export interface ReportedShell { id: string; seg: string }
export interface ReportedShells { sessions: string[]; ids: Set<string> }

/** 一段 jsonl 文本里 CC 报过的后台 shell（任务 id + 输出目录的会话段）；slug 对不上 / 路径不是该任务自己的输出文件的不收 */
export function reportedShells(text: string, slug: string): ReportedShell[] {
  const out: ReportedShell[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("backgroundTaskId")) continue;
    let r: { toolUseResult?: { backgroundTaskId?: unknown }; message?: { content?: unknown } };
    try {
      r = JSON.parse(line);
    } catch {
      continue; // 坏行 / 读到一半的首行：结构化启动结果只在完整记录里，跳过不丢
    }
    const id = r.toolUseResult?.backgroundTaskId;
    const m = typeof id === "string" ? OUT_RE.exec(JSON.stringify(r.message?.content ?? "")) : null;
    if (!m) continue;
    const [s, seg, tasks, file] = m[1].split("/").slice(-4);
    if (s === slug && SEG_RE.test(seg) && tasks === "tasks" && file === id) out.push({ id, seg });
  }
  return out;
}

/** 按主会话 jsonl 增量累计报过的后台 shell：每轮只读新增的整行，文件变短（被重写）就从尾部重来 */
export class ReportedShellDirs {
  private scans = new Map<string, { offset: number; segs: Set<string>; ids: Set<string> }>();

  async scan(jsonlPath: string, slug: string): Promise<ReportedShells> {
    const size = (await stat(jsonlPath).catch(() => null))?.size; // 主会话 jsonl 还没落盘：还没有可认的报告
    if (size === undefined) return { sessions: [], ids: new Set() };
    let s = this.scans.get(jsonlPath);
    if (!s || size < s.offset) this.scans.set(jsonlPath, (s = { offset: Math.max(0, size - TAIL_BYTES), segs: new Set(), ids: new Set() }));
    const bytes = size > s.offset ? await Bun.file(jsonlPath).slice(s.offset, size).arrayBuffer().catch(() => null) : null; // 读失败：位置不动，下轮重读
    if (bytes) {
      const buf = new Uint8Array(bytes);
      const used = buf.lastIndexOf(10) + 1; // 只吃到最后一个换行：CC 可能正写到半行
      for (const r of reportedShells(new TextDecoder().decode(buf.subarray(0, used)), slug)) {
        s.segs.add(r.seg);
        s.ids.add(r.id);
      }
      s.offset += used;
    }
    return { sessions: [...s.segs], ids: s.ids };
  }

  /** 只留还在册的主会话 jsonl（随 watcher 每小时瘦身） */
  retain(jsonlPaths: string[]): void {
    const keep = new Set(jsonlPaths);
    for (const p of this.scans.keys()) if (!keep.has(p)) this.scans.delete(p);
  }
}
