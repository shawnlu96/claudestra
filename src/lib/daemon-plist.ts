/**
 * daemon 的 launchd plist 模板（纯函数）。从 cli-install 抽出来：只拼字符串，不碰 homedir / env / 文件 / 子进程，
 * HOME、PATH、日志目录都由调用方（cli-install 的 buildDaemonPlist）取好原值显式传进来。
 * 模板字节与抽出前一致；XML 不做转义（与原来相同）。
 */
import type { DaemonSpec } from "./cli-wrapper.js";

export interface DaemonPlistInput {
  repoRoot: string;
  bunPath: string;
  daemon: Pick<DaemonSpec, "label" | "script" | "stem">;
  /** 写进 EnvironmentVariables.HOME */
  home: string;
  /** 写进 EnvironmentVariables.PATH */
  envPath: string;
  /** StandardOutPath / StandardErrorPath 所在目录 */
  logDir: string;
}

export function renderDaemonPlist({ repoRoot, bunPath, daemon, home, envPath, logDir }: DaemonPlistInput): string {
  const argv = [bunPath, `${repoRoot}/${daemon.script}`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemon.label}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>${home}</string>
    <!--
      LANG/LC_ALL 必须注入 UTF-8 locale，否则 daemon 派生的子进程（tmux 尤其）
      跑在 C locale 下会把 CJK 字符渲染成 '_' placeholder。导致 launcher 调
      manager.ts list 时拿到的 tmux window name 跟 registry 里的真实 CJK name
      不 match，永远判定 dead → 死循环 restart → zombie window 累积。
      pm2 时代不出问题是因为 pm2 从 user shell 启动，继承了 LANG。
    -->
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>LC_ALL</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>StandardOutPath</key>
  <string>${logDir}/${daemon.stem}.out</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/${daemon.stem}.err</string>
</dict>
</plist>
`;
}
