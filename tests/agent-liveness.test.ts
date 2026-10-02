/**
 * 宿主没连上时的「agent 在不在跑」（lib/agent-liveness.ts，acpSettings 的默认探针）：只有确定停了才只写 registry。
 * 用默认探针、PATH 里换上假 tmux / ps 跑在子进程里（Bun.spawn 不认运行时改的 PATH）。#447 r2：ps 失败被当成「已停」写了 registry。
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { testChildEnv } from "./test-env.ts";

type Outcome = { status: number; code: string | null; calls: number };

function stubs(bin: string, modeFile: string): void {
  const tmux = `#!/bin/sh
mode=$(cat '${modeFile}')
case "$*" in
  *list-windows*) if [ "$mode" = list-fail ]; then echo "error: permission denied" >&2; exit 1; fi; printf 'agent-x\\t@1\\n' ;;
  *list-panes*) echo 4242 ;;
  *) exit 1 ;;
esac
`;
  const ps = `#!/bin/sh
case "$(cat '${modeFile}')" in
  ps-fail) echo "ps failed" >&2; exit 1 ;;
  ps-child) printf '    1\\n 4242\\n' ;;
  *) printf '    1\\n    7\\n' ;;
esac
`;
  for (const [name, body] of [["tmux", tmux], ["ps", ps]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
}

test("默认探针：ps 失败 / 窗口清单查不到 → 409、manager 零调用；ps 正常且确无子进程才只写 registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-liveness-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const modeFile = join(root, "mode");
    stubs(bin, modeFile);
    const script = `import { writeFileSync } from "node:fs";
import { acpSettings } from "${REPO_ROOT}/src/bridge/runtime-settings-routes.ts";
const out = {};
for (const mode of ["ps-fail", "list-fail", "ps-child", "ps-nochild"]) {
  writeFileSync(${JSON.stringify(modeFile)}, mode);
  const calls = [];
  const res = await acpSettings("agent-x", "local-liveness", "m-1", "", async (...a) => (calls.push(a), { ok: true }));
  out[mode] = { status: res.status, code: (await res.json()).code ?? null, calls: calls.length };
}
console.log(JSON.stringify(out));`;
    const env = testChildEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run") });
    const p = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect([await p.exited, stderr.includes("error:") ? stderr : ""]).toEqual([0, ""]);
    const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, Outcome>;
    const offline = { status: 409, code: "acp_host_offline", calls: 0 };
    expect(out["ps-fail"]).toEqual(offline); // 非零退出 + 空输出：不确定，不是「已停」
    expect(out["list-fail"]).toEqual(offline); // tmux 出错：窗口清单 null，直接按在跑
    expect(out["ps-child"]).toEqual(offline); // 确实在跑、只是宿主还没连上
    expect(out["ps-nochild"]).toEqual({ status: 200, code: null, calls: 1 }); // 窗口在、宿主已退出：launcher 会按 registry 重起
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
