// deploy/shared-ledger 部署包：全程走 PATH 前面的假 ssh / rsync / systemctl / nginx / curl 桩，远端文件系统挪到临时根
// （SHARED_LEDGER_FS_PREFIX），不连任何真实主机、不调用真实网络。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SHARED_LEDGER_MAX_BODY_BYTES } from "../src/lib/shared-ledger-contract.ts";
import { importClosure } from "../deploy/shared-ledger/closure.ts";
import { backupLedger } from "../deploy/shared-ledger/backup.ts";
import { testChildEnv } from "./test-env.ts";

const REPO = resolve(import.meta.dir, "..");
const DEPLOY = join(REPO, "deploy/shared-ledger/deploy.sh");
const REMOTE = readFileSync(join(REPO, "deploy/shared-ledger/remote.sh"), "utf8");
const MARK = /^MARK="(.*)"$/m.exec(REMOTE)![1]!;
const TARGET = "root@ledger.example.test";
const HOST = "ledger.example.test";
const NGINX_OURS = "etc/nginx/conf.d/claudestra-shared-ledger.conf";
const UNIT = "etc/systemd/system/claudestra-shared-ledger.service";
const EXISTING_SITE = `server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name example.test *.example.test;
    ssl_certificate     /etc/ssl/example/fullchain.pem;
    ssl_certificate_key /etc/ssl/example/key.pem;
    location / { proxy_pass http://127.0.0.1:9; }
}
`;

const STUBS: Record<string, string> = {
  // ssh <目标> <命令>：在本机执行命令（stdin 照传，remote.sh 就是这样喂进去的）
  ssh: `shift; exec bash -c "$*"`,
  rsync: `log rsync "$@"
dry=0; for a in "$@"; do [ "$a" = -n ] && dry=1; done
src=\${@: -2:1}; d=\${@: -1}; dest=$SHARED_LEDGER_FS_PREFIX\${d#*:}
if diff -rq "$src" "$dest" >/dev/null 2>&1; then exit 0; fi
echo ">f+++++++++ (stub) changed"
[ $dry = 1 ] || { rm -rf "$dest"; mkdir -p "$dest"; cp -R "$src". "$dest"; }`,
  systemctl: `log systemctl "$@"
st=$STUB_DIR/state; mkdir -p "$st"
unit() { for a in "$@"; do case $a in -*|enable|disable|start|stop|restart|is-active|is-enabled) ;; *) echo "$a";; esac; done | tail -n 1; }
u=$(unit "$@"); now=0; for a in "$@"; do [ "$a" = --now ] && now=1; done
case $1 in
  is-active) [ -f "$st/active-$u" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
  is-enabled) [ -f "$st/enabled-$u" ] && exit 0; exit 1 ;;
  start|restart) [ -f "$STUB_DIR/start-fail" ] && exit 1; touch "$st/active-$u" ;;
  enable) touch "$st/enabled-$u"; [ $now = 1 ] && touch "$st/active-$u" ;;
  disable) rm -f "$st/enabled-$u"; [ $now = 1 ] && rm -f "$st/active-$u" ;;
esac; exit 0`,
  nginx: `log nginx "$@"
P=$SHARED_LEDGER_FS_PREFIX
case $1 in
  -t) [ -f "$STUB_DIR/nginx-fail" ] && [ -f "$P/${NGINX_OURS}" ] && { echo "nginx: [emerg] stub failure" >&2; exit 1; }; exit 0 ;;
  -T) for f in "$P"/etc/nginx/conf.d/*.conf; do echo "# configuration file \${f#$P}:"; cat "$f"; done ;;
esac`,
  curl: `log curl "$@"
out=/dev/null; url=; while [ $# -gt 0 ]; do case $1 in -o) out=$2; shift;; -w|--max-time|--resolve) shift;; http*) url=$1;; esac; shift; done
[ -f "$STUB_DIR/health-fail" ] && { printf 000; exit 7; }
case $url in *"/v1/teams/"*) printf '{"code":"bad_signature"}' > "$out"; printf 401;; *) printf 404;; esac`,
  journalctl: `echo "stub journal tail"`,
  getent: `[ -f "$STUB_DIR/state/user" ] || exit 2; echo "claudestra-ledger:x:999:999::/var/lib/claudestra-shared-ledger:/usr/sbin/nologin"`,
  useradd: `log useradd "$@"; mkdir -p "$STUB_DIR/state"; touch "$STUB_DIR/state/user"`,
  chown: `log chown "$@"`,
  openssl: `echo "Hostname does match certificate"`,
  ss: `exit 0`,
};

let dir = "", root = "", bin = "";
const log = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");
const clearLog = () => rmSync(join(dir, "calls.log"), { force: true });
const at = (p: string) => join(root, p);

function deploy(...args: string[]) {
  const r = spawnSync("bash", [DEPLOY, TARGET, ...args], {
    cwd: REPO, encoding: "utf8",
    env: testChildEnv({ PATH: `${bin}:${process.env.PATH}`, SHARED_LEDGER_FS_PREFIX: root, STUB_DIR: dir, SHARED_LEDGER_HEALTH_TRIES: "2" }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const install = (...extra: string[]) => deploy("--host-name", HOST, "--bun", "/usr/local/bin/bun", ...extra);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sl-deploy-"));
  root = join(dir, "root");
  bin = join(dir, "bin");
  for (const d of ["bin", "root/etc/nginx/conf.d", "root/etc/systemd/system", "root/etc/ssl/example", "root/opt", "root/usr/local/bin"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(at("etc/nginx/conf.d/example.conf"), EXISTING_SITE);
  writeFileSync(at("etc/ssl/example/fullchain.pem"), "stub cert\n");
  writeFileSync(at("etc/ssl/example/key.pem"), "stub key\n");
  writeFileSync(at("usr/local/bin/bun"), "#!/bin/sh\necho 1.3.14\n");
  chmodSync(at("usr/local/bin/bun"), 0o755);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nlog() { echo "$*" >> "$STUB_DIR/calls.log"; }\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deploy.sh --dry-run", () => {
  test("只读：不写远端文件、不动服务，打印单元与 nginx 块", () => {
    const r = deploy("--host-name", HOST, "--dry-run");
    expect(r.code).toBe(0);
    expect(readdirSync(at("etc/systemd/system"))).toEqual([]);
    expect(readdirSync(at("etc/nginx/conf.d"))).toEqual(["example.conf"]);
    expect(existsSync(at("opt/claudestra-shared-ledger"))).toBe(false);
    expect(existsSync(at("var"))).toBe(false);
    expect(log()).not.toMatch(/systemctl (start|restart|reload|daemon-reload|enable)|useradd|chown/);
    expect(log()).toMatch(/rsync .*-n/);
    expect(r.out).toContain("[dry-run] 写入 /etc/systemd/system/claudestra-shared-ledger.service");
    expect(r.out).toContain("[dry-run] 写入 /etc/nginx/conf.d/claudestra-shared-ledger.conf");
    expect(r.out).toContain("[dry-run] useradd");
  });

  test("systemd 单元：只在回环上监听，独立库，on-failure 重启，带加固与资源上限", () => {
    const out = deploy("--host-name", HOST, "--port", "8811", "--dry-run").out;
    const exec = /ExecStart=(.*)/.exec(out)![1]!;
    expect(exec).toBe("/usr/local/bin/bun --no-env-file src/shared-ledger.ts --db /var/lib/claudestra-shared-ledger/db/shared-ledger.sqlite --port 8811");
    // 中心入口不收 hostname 参数，startServer 只接受回环地址；单元在网络层再只许与本机通信
    expect(readFileSync(join(REPO, "src/shared-ledger.ts"), "utf8")).not.toContain("hostname");
    expect(readFileSync(join(REPO, "src/shared-ledger/server.ts"), "utf8")).toContain('options.hostname ?? "127.0.0.1"');
    for (const line of ["IPAddressDeny=any", "IPAddressAllow=localhost", "Restart=on-failure", "NoNewPrivileges=true",
      "ProtectSystem=strict", "ProtectHome=true", "PrivateTmp=true", "UMask=0077", "MemoryMax=512M", "TasksMax=64",
      "ReadWritePaths=/var/lib/claudestra-shared-ledger/db", "User=claudestra-ledger"]) expect(out).toContain(line);
    expect(out).not.toContain("MemoryDenyWriteExecute");
    expect(out).not.toContain("0.0.0.0");
    expect(out).not.toContain("claudestra-relay");
  });

  test("nginx 块：只反代 API 路径、其余 404，带 body 上限、超时与 limit_req，复用已探测的证书", () => {
    const out = deploy("--host-name", HOST, "--dry-run").out;
    const block = out.split("\n").filter((l) => l.startsWith("      | ")).map((l) => l.slice(8)).join("\n");
    expect(block).toContain(`server_name ${HOST};`);
    expect(block).toContain("listen 443 ssl;");
    expect(block).toContain("listen [::]:443 ssl;");
    expect(block).toContain("ssl_certificate     /etc/ssl/example/fullchain.pem;");
    expect(block).toContain("ssl_certificate_key /etc/ssl/example/key.pem;");
    expect(block).toContain("client_max_body_size 1m;");
    expect(block).toContain("proxy_read_timeout 15s;");
    expect(block).toMatch(/limit_req_zone \$binary_remote_addr zone=claudestra_shared_ledger:\S+ rate=\S+;/);
    expect(block).toContain("limit_req zone=claudestra_shared_ledger");
    const proxied = [...block.matchAll(/location ([^{]+)\{\n\s+(\S+)/g)].map((m) => [m[1]!.trim(), m[2]]);
    expect(proxied).toEqual([
      ['~ "^/v1/teams/[A-Za-z0-9_.:-]+/(features|commands|imports|projections)(/[A-Za-z0-9_.:-]+)?$"', "proxy_pass"],
      ["/", "return"],
    ]);
    expect(block).toMatch(/location \/ \{\n\s+return 404;/);
    expect(block).toContain("proxy_pass http://127.0.0.1:8797;");
  });

  test("nginx 的路径正则与 body 上限跟服务端一致", () => {
    const service = readFileSync(join(REPO, "src/shared-ledger/service.ts"), "utf8");
    const route = new RegExp(/const route = \/(.*)\/\.exec\(req\.path\)/.exec(service)![1]!);
    const nginx = new RegExp(/^API_RE='(.*)'$/m.exec(REMOTE)![1]!);
    const paths = ["/v1/teams/t1/features", "/v1/teams/t1/features/f-1", "/v1/teams/t.1:x/commands/r_2", "/v1/teams/t/imports",
      "/v1/teams/t/projections", "/v1/teams/t/other", "/v1/teams/t/features/a/b", "/v1/teams//features", "/healthz", "/", "/v2/teams/t/features"];
    expect(paths.map((p) => nginx.test(p))).toEqual(paths.map((p) => route.test(p)));
    expect(paths.filter((p) => nginx.test(p))).toHaveLength(5);
    expect(SHARED_LEDGER_MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(REMOTE).toMatch(/^BODY_LIMIT=1m$/m);
  });

  test("找不到覆盖域名的已有证书就失败，不申请证书", () => {
    const r = deploy("--host-name", "ledger.other.test", "--dry-run");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("不申请证书");
  });
});

describe("deploy.sh 安装", () => {
  test("首装写单元 / nginx 块（带标记头），reload nginx；已有 server 块文件原样不动", () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(readFileSync(at(UNIT), "utf8").split("\n")[0]).toBe(MARK);
    expect(readFileSync(at(NGINX_OURS), "utf8").split("\n")[0]).toBe(MARK);
    expect(readFileSync(at("etc/nginx/conf.d/example.conf"), "utf8")).toBe(EXISTING_SITE);
    expect(existsSync(at("opt/claudestra-shared-ledger/src/shared-ledger.ts"))).toBe(true);
    expect(existsSync(at("opt/claudestra-shared-ledger/deploy/shared-ledger/backup.ts"))).toBe(true);
    expect(existsSync(at("opt/claudestra-shared-ledger/src/bridge.ts"))).toBe(false);
    for (const d of ["var/lib/claudestra-shared-ledger/db", "var/backups/claudestra-shared-ledger"]) {
      expect(statSync(at(d)).mode & 0o777).toBe(0o700);
    }
    for (const call of ["useradd --system", "systemctl daemon-reload", "systemctl enable claudestra-shared-ledger",
      "systemctl enable --now claudestra-shared-ledger-backup.timer", "systemctl start claudestra-shared-ledger", "nginx -t", "systemctl reload nginx"]) {
      expect(log()).toContain(call);
    }
    expect(log()).toContain("http://127.0.0.1:8797/v1/teams/healthcheck/features");
    expect(log()).toContain(`--resolve ${HOST}:443:127.0.0.1 https://${HOST}/v1/teams/healthcheck/features`);
    expect(r.out).toContain("HTTPS 入口自检");
  });

  test("幂等：第二次不写文件、不 daemon-reload、不重启、不 reload nginx", () => {
    expect(install().code).toBe(0);
    const files = [UNIT, NGINX_OURS, "etc/systemd/system/claudestra-shared-ledger-backup.timer"];
    const before = files.map((f) => statSync(at(f)).mtimeMs);
    clearLog();
    const r = install();
    expect(r.code).toBe(0);
    expect(r.out).toContain("代码未变");
    expect(r.out).not.toMatch(/^\s+\+ /m);
    expect(files.map((f) => statSync(at(f)).mtimeMs)).toEqual(before);
    expect(log()).not.toMatch(/useradd|chown|daemon-reload|systemctl (start|restart|reload|enable)/);
  });

  test("参数变了才重写单元并重启", () => {
    expect(install().code).toBe(0);
    clearLog();
    expect(install("--port", "8812").code).toBe(0);
    expect(readFileSync(at(UNIT), "utf8")).toContain("--port 8812");
    expect(log()).toContain("systemctl daemon-reload");
    expect(log()).toContain("systemctl restart claudestra-shared-ledger");
    expect(log()).toContain("systemctl reload nginx");
  });

  test("nginx -t 失败：删掉本次新写的 server 块、不 reload、退出非 0", () => {
    writeFileSync(join(dir, "nginx-fail"), "");
    const r = install();
    expect(r.code).not.toBe(0);
    expect(existsSync(at(NGINX_OURS))).toBe(false);
    expect(log()).not.toContain("systemctl reload nginx");
    expect(r.err).toContain("nginx -t 未通过");
    expect(readFileSync(at("etc/nginx/conf.d/example.conf"), "utf8")).toBe(EXISTING_SITE);
  });

  test("nginx -t 失败于更新：恢复本脚本的上一版", () => {
    expect(install().code).toBe(0);
    const previous = readFileSync(at(NGINX_OURS), "utf8");
    writeFileSync(join(dir, "nginx-fail"), "");
    clearLog();
    expect(install("--port", "8813").code).not.toBe(0);
    expect(readFileSync(at(NGINX_OURS), "utf8")).toBe(previous);
    expect(log()).not.toContain("systemctl reload nginx");
  });

  test("同名文件已存在且没有标记头：拒绝覆盖，原样保留", () => {
    const foreign = "server { server_name someone-else; }\n";
    writeFileSync(at(NGINX_OURS), foreign);
    const r = install();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("拒绝覆盖");
    expect(readFileSync(at(NGINX_OURS), "utf8")).toBe(foreign);
    expect(log()).not.toContain("systemctl reload nginx");
  });

  test("同名 systemd 单元不是本脚本写的：拒绝覆盖", () => {
    writeFileSync(at(UNIT), "[Service]\nExecStart=/bin/true\n");
    const r = install();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("拒绝覆盖");
    expect(readFileSync(at(UNIT), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  });

  test("健康检查失败：退出非 0 并打印服务日志尾部，不碰 nginx", () => {
    writeFileSync(join(dir, "health-fail"), "");
    const r = install();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("健康检查失败");
    expect(r.err).toContain("stub journal tail");
    expect(existsSync(at(NGINX_OURS))).toBe(false);
  });

  test("远端 bun 太旧就拒绝", () => {
    writeFileSync(at("usr/local/bin/bun"), "#!/bin/sh\necho 1.1.0\n");
    const r = install();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("低于");
  });
});

describe("deploy.sh --uninstall", () => {
  test("停服务、移除本脚本的单元与 nginx 块并 reload，保留库与备份", () => {
    expect(install().code).toBe(0);
    writeFileSync(at("var/lib/claudestra-shared-ledger/db/shared-ledger.sqlite"), "");
    clearLog();
    const r = deploy("--uninstall");
    expect(r.code).toBe(0);
    expect(existsSync(at(NGINX_OURS))).toBe(false);
    expect(existsSync(at(UNIT))).toBe(false);
    expect(log()).toContain("systemctl disable --now claudestra-shared-ledger");
    expect(log()).toContain("systemctl reload nginx");
    expect(existsSync(at("var/lib/claudestra-shared-ledger/db/shared-ledger.sqlite"))).toBe(true);
    expect(existsSync(at("var/backups/claudestra-shared-ledger"))).toBe(true);
    expect(readFileSync(at("etc/nginx/conf.d/example.conf"), "utf8")).toBe(EXISTING_SITE);
  });

  test("不是本脚本写的 nginx 文件：拒绝删除", () => {
    writeFileSync(at(NGINX_OURS), "server {}\n");
    const r = deploy("--uninstall");
    expect(r.code).not.toBe(0);
    expect(readFileSync(at(NGINX_OURS), "utf8")).toBe("server {}\n");
  });

  test("--dry-run 卸载不动任何东西", () => {
    expect(install().code).toBe(0);
    clearLog();
    expect(deploy("--uninstall", "--dry-run").code).toBe(0);
    expect(existsSync(at(NGINX_OURS))).toBe(true);
    expect(log()).not.toMatch(/systemctl (disable|reload|daemon-reload)/);
  });
});

describe("部署包的组成", () => {
  test("代码清单按 import 闭包算，只含中心所需源码、不依赖 npm 包", () => {
    const { files, packages } = importClosure("src/shared-ledger.ts");
    expect(packages).toEqual([]);
    expect(files).toContain("src/shared-ledger.ts");
    expect(files).toContain("src/shared-ledger/server.ts");
    expect(files.every((f) => f.startsWith("src/"))).toBe(true);
    expect(files).not.toContain("src/relay.ts");
  });

  test("每日备份：VACUUM INTO 出 0600 一致性副本，清理 7 天前的旧备份", () => {
    const db = join(dir, "live.sqlite");
    const live = new Database(db);
    live.run("PRAGMA journal_mode=WAL");
    live.run("CREATE TABLE t(a)");
    live.run("INSERT INTO t VALUES (42)");
    const backups = join(dir, "backups");
    mkdirSync(backups);
    const old = join(backups, "shared-ledger-20200101T000000Z.sqlite");
    const foreign = join(backups, "keep-me.sqlite");
    writeFileSync(old, "");
    writeFileSync(foreign, "");
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(foreign, eightDaysAgo, eightDaysAgo);
    const { file, pruned } = backupLedger(db, backups, 7);
    live.close();
    expect(pruned).toEqual(["shared-ledger-20200101T000000Z.sqlite"]);
    expect(existsSync(foreign)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const copy = new Database(file, { readonly: true });
    expect(copy.query("SELECT a FROM t").get()).toEqual({ a: 42 });
    copy.close();
  });

  test("自检：部署包里没有真实地址、凭据或个人信息", () => {
    const tracked = ["deploy/shared-ledger/deploy.sh", "deploy/shared-ledger/remote.sh", "deploy/shared-ledger/closure.ts",
      "deploy/shared-ledger/backup.ts", "deploy/shared-ledger/README.md", "tests/shared-ledger-deploy.test.ts"];
    // 拆开拼，免得本文件自己命中
    const personal = new RegExp(["/Us" + "ers/", "/ho" + "me/[a-z]", "BEGIN [A-Z ]*PRIV" + "ATE KEY", "gh" + "p_", "sk-" + "ant-"].join("|"));
    for (const f of tracked) {
      const text = readFileSync(join(REPO, f), "utf8");
      const ips = [...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]);
      expect(ips.filter((ip) => ip !== "127.0.0.1" && ip !== "0.0.0.0")).toEqual([]);
      expect(text).not.toMatch(personal);
      const domains = [...text.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|jp|cn|app)\b/gi)].map((m) => m[0]);
      expect(domains.filter((d) => !/(^|\.)(github\.com|claude\.com|bun\.sh)$/.test(d))).toEqual([]);
    }
  });
});
