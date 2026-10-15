import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { testChildEnv } from "./test-env.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Exercise the same setter used by each caller, including every exported read/modify/write entry.
const writes: [string, string, string][] = [
  ["bridge/api-routes archive", "setArchiveRetention(12)", "cfg.archiveRetentionDays===12"],
  ["manager/codex-sub-archive", "setAutoArchiveCodexSubs(true)", "cfg.autoArchiveCodexSubs===true"],
  ["manager/auto-update channel + bridge/update-routes", "setUpdateChannel('beta')", "cfg.autoUpdate.channel==='beta'"],
  ["manager/auto-update toggle + bridge/update-routes", "setAutoUpdate('floka',true)", "cfg.autoUpdate.claudestra===true"],
  ["setup + bridge/local-api/settings language", "setLang('en')", "cfg.lang==='en'"],
  ["bridge/stats-dashboard channel and message", "setStatsDashboard('channel','message')", "cfg.statsDashboard?.messageId==='message'"],
  ["idle-hours legacy setter", "setAutoCompactIdleHours(2)", "cfg.autoCompact?.idleHours===2"],
  ["manager/ctx-boundary + bridge/auto-compact-routes", "setAutoCompact({inject:true,window:123})", "cfg.autoCompact?.inject&&cfg.autoCompact.window===123"],
  ["bridge/quota-service", "setQuotaLive(false)", "cfg.quotaLive===false"],
  ["bridge/local-api/settings push redaction", "setPushNoContent(true)", "cfg.pushNoContent===true"],
  ["bridge/local-api/settings asks", "setPushAllAsks(true)", "cfg.pushAllAsks===true"],
  ["bridge/local-api/settings talk", "setTalkEnabled(true)", "cfg.talkEnabled===true"],
  ["manager/peer-relay-strict + bridge/peer-relay-strict", "setPeerRelayJoinStrict(true)", "cfg.peerRelayJoinStrict===true"],
  ["bridge/local-api/settings Groq", "setGroqApiKey('fixture-key')", "cfg.groqApiKey==='fixture-key'"],
  ["bridge/local-api/settings Jev", "setJevApiKey('fixture-key')", "cfg.jevApiKey==='fixture-key'"],
  ["bridge/local-api/guard", "setChatGuard({mode:'off'})", "cfg.chatGuard?.mode==='off'"],
  ["manager/state-maintenance", "setRenameStateMode('observe')", "cfg.rename?.state==='observe'"],
  ["lib/web-state-migrate", "adoptWebSettings({lang:'en',groqApiKey:'fixture-key'})", "cfg.lang==='en'&&cfg.groqApiKey==='fixture-key'"],
];
function run(call: string, conflicts: number, verify: string) {
  const home = mkdtempSync(join(tmpdir(), "floka-config-writes-")); roots.push(home);
  const root = join(home, ".claude-orchestrator"); mkdirSync(root);
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ autoUpdate: { claudestra: false }, opaque: { keep: true } }));
  const code = `import {mock} from 'bun:test'; import {readFileSync,writeFileSync} from 'node:fs';
    const store=await import('./src/lib/floka-config/store.ts'), realWrite=store.writeCompatibleConfig;
    let attempts=0; const path=${JSON.stringify(path)};
    mock.module('./src/lib/floka-config/store.ts',()=>({...store,writeCompatibleConfig:async(...args)=>{
      attempts++; if(attempts<=${conflicts}) { const disk=JSON.parse(readFileSync(path,'utf8')); disk.concurrent=attempts; writeFileSync(path,JSON.stringify(disk)); }
      return realWrite(...args);
    }}));
    const c=await import('./src/lib/config-store.ts');
    let ok=true,error=null,typed=false; try { await c.${call}; } catch(e) { ok=false; error=e.message; typed=e.name==='ConfigChangedError'; }
    const cfg=await c.readConfig();
    console.log(JSON.stringify({ok,error,typed,attempts,valid:Boolean(${verify}),disk:JSON.parse(readFileSync(path,'utf8'))}));`;
  const r = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: resolve(import.meta.dir, ".."), env: testChildEnv({ HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "run") }),
    encoding: "utf8", timeout: 20_000,
  });
  expect(r.stderr && r.status !== 0 ? r.stderr : r.status).toBe(0);
  return { ...JSON.parse(r.stdout), stderr: r.stderr };
}
for (const [caller, call, verify] of writes) {
  for (const conflicts of [1, 2]) {
    test(`[验收线 2] ${caller}: ${conflicts} stale write(s)`, () => {
      const r = run(call, conflicts, verify);
      expect(r.attempts).toBe(2);
      expect(r.ok).toBe(conflicts === 1);
      expect(r.disk.concurrent).toBe(conflicts);
      expect(r.disk.opaque.keep).toBe(true);
      if (conflicts === 1) expect(r.valid).toBe(true);
      else {
        expect(r.typed).toBe(true);
        expect(r.error).toBe("配置刚被别处改过,请重试");
        expect(r.stderr).toContain("配置刚被别处改过,请重试");
        expect(r.valid).toBe(false);
      }
    });
  }
}
