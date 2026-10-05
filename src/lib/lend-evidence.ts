/**
 * 出借 worker 回合失败停单前留证据（lend-drive keepEvidence）：stopped 的工作副本 24 小时后被清（lend-work-retention.ts），
 * worker 开跑之后写过的文件复制到 logs/lend-evidence/<单目录>/work/，index.txt 记原因和不随结单删除的现场：
 * ACP 宿主日志（logs/acp/<agent>/ 的 app-server.log、host.log，没有任何收尾会删，只记路径不复制）、kill 前的 pane 存档。
 * 不跑 git：副本的 .git/config 归 worker 改（core.fsmonitor 之类会在出借服务里执行），按 mtime 认产物。只留本机，不发给 A。
 * 旁路：失败只记日志返回 null，停单照常。tests/lend-turn-failure.test.ts。
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { orderDirName } from "./lend-clone.js";
import type { LendRow } from "./lend-journal.js";
import { acpLogDir, LOG_DIR } from "./log-paths.js";

const EVIDENCE_ROOT = join(LOG_DIR, "lend-evidence");
const FILE_MAX = 1024 * 1024;
const TOTAL_MAX = 16 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * dir 下 since 之后改过的普通文件（相对路径）；不跟随软链，跳过 .git / node_modules。
 * ponytail: mtime 认产物，worker 用 touch 改回旧时间就漏；单文件 1 MiB、累计 16 MiB 封顶，超了的跳过（index 里写明）
 */
function workerFiles(dir: string, since: number): string[] {
  const out: string[] = [];
  let total = 0;
  for (const stack = [dir]; stack.length;) {
    const cur = stack.pop()!;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name);
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) stack.push(p);
      if (!e.isFile()) continue;
      const st = lstatSync(p);
      if (st.mtimeMs < since || st.size > FILE_MAX || total + st.size > TOTAL_MAX) continue;
      total += st.size;
      out.push(relative(dir, p));
    }
  }
  return out.sort();
}

/** 返回存放处；同一张单再调一次覆盖同一处（停单没确认、下一轮重做） */
export function keepLendEvidence(row: Pick<LendRow, "orderId" | "agent" | "sessionId" | "dir" | "startedAt" | "createdAt">, why: string,
  root = EVIDENCE_ROOT, log: (m: string) => void = (m) => console.error(`[lend] ${m}`)): string | null {
  try {
    const dest = join(root, orderDirName(row.orderId));
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    chmodSync(dest, 0o700); // 产物里有出借方仓库内容：只给本用户看（同 lend-pane-archive）
    const present = row.dir !== null && lstatSync(row.dir, { throwIfNoEntry: false })?.isDirectory() === true;
    const files = present ? workerFiles(row.dir!, row.startedAt ?? row.createdAt) : [];
    for (const f of files) {
      mkdirSync(dirname(join(dest, "work", f)), { recursive: true, mode: 0o700 });
      copyFileSync(join(row.dir!, f), join(dest, "work", f));
      chmodSync(join(dest, "work", f), 0o600); // copyFile 照搬源文件权限（常见 0644）；重做覆盖时也要再收紧
    }
    const agent = row.agent ?? "?";
    writeFileSync(join(dest, "index.txt"), [
      `# 出借单 ${row.orderId} 停单证据 @ ${new Date().toISOString()}`, `agent: ${agent}`, `session: ${row.sessionId ?? "?"}`, `原因: ${why}`,
      `ACP 宿主日志（结单不删，未复制）: ${acpLogDir(agent)}`, `kill 前 pane 存档: ${join(LOG_DIR, "lend", agent)}`,
      `工作副本: ${row.dir ?? "?"}${present ? "（stopped 后 24 小时清掉）" : "（已不在）"}`,
      `worker 开跑后写过的文件 ${files.length} 个，复制在 work/ 下（单个 > 1 MiB 或累计超 16 MiB 的没复制）:`, ...files.map((f) => `- ${f}`), "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(join(dest, "index.txt"), 0o600); // mode 只管新建：重做时覆盖已有的 index 不改权限
    return dest;
  } catch (e) {
    log(`存 ${row.orderId} 的证据失败（停单照常）：${(e as Error).message}`);
    return null;
  }
}
