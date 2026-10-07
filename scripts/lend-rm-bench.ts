/**
 * SCH-2 证据脚本：删一份出借工作副本时调度服务主线程卡多久、本进程记了多少写入。
 * 用法：bun scripts/lend-rm-bench.ts <要复制的样本目录> [rmSync|trash]...
 * 样本先 `cp -cR`（APFS clonefile，和 bun install 落 node_modules 的方式一样）再 `cp -R`（实拷）各复制一份，每份按给的方式删：
 * 计时器每 5ms 打点，记最大间隔（主线程被同步调用卡住的时长）；proc_pid_rusage 读本进程 logical_writes / diskio_byteswritten 的增量
 * （macOS「disk writes」诊断报告按 logical writes 记账）。只读样本、只删自己复制出的目录。
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdtempSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trashAway, trashSettled } from "../src/lib/lend-clone.js";

const lib = dlopen("/usr/lib/libSystem.B.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
const buf = new BigUint64Array(64);
/** rusage_info_v4：16 字节 uuid 之后全是 u64；diskio_byteswritten 在第 17 个、logical_writes 在第 27 个 */
function usage(): { logical: number; disk: number } {
  if (lib.symbols.proc_pid_rusage(process.pid, 4, ptr(buf)) !== 0) throw new Error("proc_pid_rusage 失败");
  return { logical: Number(buf[2 + 27]), disk: Number(buf[2 + 17]) };
}

function census(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else { files++; bytes += lstatSync(p).size; }
    }
  }
  return { files, bytes };
}

async function measure(dir: string, how: string): Promise<Record<string, unknown>> {
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 5);
  await Bun.sleep(50);
  const u0 = usage();
  const t0 = performance.now();
  let callMs = 0;
  if (how === "rmSync") { rmSync(dir, { recursive: true, force: true }); callMs = performance.now() - t0; }
  else { trashAway(dir, join(dir, "..", "trash")); callMs = performance.now() - t0; await trashSettled(); }
  const totalMs = performance.now() - t0;
  await Bun.sleep(50);
  clearInterval(timer);
  const u1 = usage();
  const mb = (n: number) => +(n / 1048576).toFixed(1);
  return { how, callMs: Math.round(callMs), totalMs: Math.round(totalMs), maxTimerGapMs: Math.round(maxGap), logicalWritesMB: mb(u1.logical - u0.logical), diskWritesMB: mb(u1.disk - u0.disk) };
}

const [src, ...ways] = process.argv.slice(2);
if (!src) throw new Error("用法：bun scripts/lend-rm-bench.ts <样本目录> [rmSync|trash]...");
const c = census(src);
console.log(JSON.stringify({ sample: { files: c.files, MB: +(c.bytes / 1048576).toFixed(1) } }));
for (const how of ways.length ? ways : ["rmSync", "trash"]) {
  for (const mode of ["-cR", "-R"]) {
    const root = mkdtempSync(join(tmpdir(), "lend-rm-bench-"));
    const dir = join(root, "copy");
    const cp = Bun.spawnSync(["cp", mode, src, dir]);
    if (cp.exitCode !== 0) throw new Error(`cp ${mode} 失败：${cp.stderr.toString()}`);
    await Bun.sleep(Number(process.env.BENCH_SETTLE_MS ?? 3000)); // 拷完等多久再删：脏页还没落盘时删会不会把写入记到删除方头上
    console.log(JSON.stringify({ copy: mode === "-cR" ? "clonefile" : "实拷", ...(await measure(dir, how)) }));
    rmSync(root, { recursive: true, force: true });
  }
}
