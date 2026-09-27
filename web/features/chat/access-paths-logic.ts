/**
 * 设置 ·「访问」页顶部的总览（components/access-paths.tsx）：手机连到这台电脑的四条路各自开没开、地址是什么。
 * 数据：GET /api/v1/access-paths（中继 + 局域网）与 GET /api/v1/remote-access（Tailscale 与反代入口）。纯函数，tests/web-access-paths.test.ts。
 */

export interface AccessPathsInfo {
  relay: { enabled: boolean; connected: boolean; state: string | null; home: string | null };
  lan: { bind: string; bindAll: boolean; urls: string[] };
}

/** /remote-access 快照里这里用到的部分（remote-access-section.tsx 的 Snapshot 子集） */
export interface EntriesView {
  tailscale: { installed: boolean; running: boolean };
  entries: Array<{ url: string; secure: boolean; source: string; reachable: boolean; matchesLocal: boolean }>;
}

export type PathState = "on" | "partial" | "off";
export interface PathRow {
  id: "relay" | "tailscale" | "lan" | "domain";
  state: PathState;
  url?: string;
  /** 中文 key，渲染点过 t() */
  note: string;
}

const isTsNet = (u: string) => {
  try {
    return new URL(u).hostname.endsWith(".ts.net");
  } catch {
    return false; // 不是合法 URL 的入口不算 ts.net，交给「自己的域名」一栏去判
  }
};
const usable = (e: EntriesView["entries"][number]) => e.secure && e.reachable && e.matchesLocal;

export function accessRows(a: AccessPathsInfo | null, snap: EntriesView | null): PathRow[] {
  const rows: PathRow[] = [];
  if (a) {
    const r = a.relay;
    rows.push(
      !r.enabled
        ? { id: "relay", state: "off", note: "没配。重跑 bun run setup 选「中继」即可开启" }
        : r.connected
          ? { id: "relay", state: "on", url: r.home ?? undefined, note: "手机不装任何东西，任何网络都能打开；中继能看到经过它的内容" }
          : { id: "relay", state: "partial", url: r.home ?? undefined, note: "配了但还没连上，bridge 会自己重试" },
    );
  }
  if (snap) {
    const ts = snap.entries.find((e) => usable(e) && isTsNet(e.url));
    rows.push(
      ts
        ? { id: "tailscale", state: "on", url: ts.url, note: "内容只在你自己的设备之间走；手机要装 Tailscale 并登录同一个账号" }
        : snap.tailscale.running
          ? { id: "tailscale", state: "partial", note: "Tailscale 连着，但还没有能用的 HTTPS 入口，见下方" }
          : { id: "tailscale", state: "off", note: snap.tailscale.installed ? "装了但没连上，见下方" : "没装。重跑 bun run setup 选「Tailscale」会一步步引导" },
    );
  }
  if (a) {
    const lan = a.lan;
    rows.push(
      lan.bindAll
        ? { id: "lan", state: "on", url: lan.urls[0], note: "只在同一 Wi-Fi 下能用；明文，推送和语音输入用不了" }
        : { id: "lan", state: "off", note: "bridge 只监听本机。要用就在 .env 写 BRIDGE_BIND=0.0.0.0 后重启 bridge（公共网络别开）" },
    );
  }
  if (snap) {
    const own = snap.entries.find((e) => usable(e) && !isTsNet(e.url));
    rows.push(
      own
        ? { id: "domain", state: "on", url: own.url, note: "经你自己的反向代理" }
        : { id: "domain", state: "off", note: "高级：自己的域名 + Caddy / nginx，见 web/SETUP.md「Public reverse proxy」" },
    );
  }
  return rows;
}
