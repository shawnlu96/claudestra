/** i28-A2 §2 安全面判定：真实 PR 的文件清单当夹具（#296–#310），加上读不全 / 超量 / 改名 / 额外规则。 */
import { describe, expect, test } from "bun:test";
import { MAX_FILES, peerPrSurface, type ChangedFile } from "../src/lib/peer-pr-surface.ts";

const list = (...paths: string[]): ChangedFile[] => paths.map((path) => ({ path }));

const PRS: Record<number, { files: string[]; surface: "security" | "plain" }> = {
  296: { surface: "plain", files: ["src/lib/auq-echo.ts", "src/lib/session-history.ts", "tests/session-history-open-tools.test.ts", "tests/web-fmt-clock.test.ts",
    "tests/web-history-shape.test.ts", "web/features/chat/components/bg-task-panel.tsx", "web/features/chat/components/tool-rows.tsx",
    "web/features/chat/fmt-clock.ts", "web/features/chat/use-now.ts", "web/lib/chat/history-shape.ts"] },
  297: { surface: "security", files: ["src/lib/acp/adapter-proc.ts", "src/lib/acp/pi-adapter/main.ts", "tests/fixtures/pi-rpc-0.99.1.jsonl", "tests/pi-acp-map.test.ts"] },
  298: { surface: "plain", files: ["tests/legacy-web.test.ts"] },
  299: { surface: "plain", files: ["tests/peer-get-replay.test.ts"] },
  300: { surface: "security", files: ["src/acp-host.ts", "src/bridge/acp-link.ts", "src/bridge/runtime-settings-routes.ts", "src/lib/acp/host.ts"] },
  303: { surface: "security", files: ["src/bridge.ts", "src/bridge/event-bus.ts", "src/bridge/relay-dispatch.ts", "src/lib/relay-client.ts",
    "tests/relay-e2e.test.ts", "web/lib/api/ledger.ts", "web/lib/api/stream.ts"] },
  310: { surface: "security", files: ["src/bridge/api-routes.ts", "src/lib/auq-pane.ts", "src/lib/pane-tail.ts", "src/lib/tmux-helper.ts", "tests/pane-tail.test.ts"] },
};

describe("peerPrSurface", () => {
  for (const [n, pr] of Object.entries(PRS)) {
    test(`#${n} 判 ${pr.surface}`, () => {
      const v = peerPrSurface(list(...pr.files));
      expect(v.surface).toBe(pr.surface);
      expect(v.reasons.length > 0).toBe(pr.surface === "security");
    });
  }

  test("理由逐个文件列出、按文件顺序", () => {
    expect(peerPrSurface(list("src/lib/x.ts", "src/bridge.ts", "scripts/a.sh")).reasons).toEqual(["文件 src/bridge.ts：src/bridge.ts", "目录 scripts/：scripts/a.sh"]);
  });

  test("读不全 / 空 / 超量都按安全面算", () => {
    expect(peerPrSurface(null)).toEqual({ surface: "security", reasons: ["文件清单读不全：按碰了安全面算"] });
    expect(peerPrSurface([]).surface).toBe("security");
    expect(peerPrSurface(list(...Array.from({ length: MAX_FILES + 1 }, (_, i) => `src/lib/f${i}.ts`))).reasons[0]).toContain(`超过 ${MAX_FILES}`);
  });

  test("改名的旧路径也算", () => {
    expect(peerPrSurface([{ path: "src/lib/plain.ts", previous: "src/lib/acp/host.ts" }]).reasons).toEqual(["目录 src/lib/acp/：src/lib/acp/host.ts"]);
  });

  test("文件名关键词只管 src / web，tests 与 docs 不管", () => {
    expect(peerPrSurface(list("src/lib/peer-names.ts")).reasons).toEqual(["文件名含 peer：src/lib/peer-names.ts"]);
    expect(peerPrSurface(list("tests/token-x.test.ts", "docs/auth.md")).surface).toBe("plain");
  });

  test("未知根目录、.claude、根 CLAUDE.md、路径穿越", () => {
    expect(peerPrSurface(list("foo/bar.ts")).reasons[0]).toContain("不在 src/ tests/ docs/ web/ 下");
    expect(peerPrSurface(list("docs/.claude/settings.json")).reasons[0]).toContain("目录 .claude/");
    expect(peerPrSurface(list("CLAUDE.zh-CN.md")).reasons[0]).toContain("根目录 CLAUDE*.md");
    expect(peerPrSurface(list("src/../scripts/x.ts")).reasons[0]).toContain("路径格式不对");
    expect(peerPrSurface(list("README.md")).surface).toBe("plain");
  });

  test("peer-prs.json 的额外规则", () => {
    expect(peerPrSurface(list("src/lib/ledger-x.ts"), ["src/lib/ledger-*.ts"]).reasons).toEqual(["额外规则 src/lib/ledger-*.ts：src/lib/ledger-x.ts"]);
    expect(peerPrSurface(list("src/lib/other.ts"), ["src/lib/ledger-*.ts"]).surface).toBe("plain");
  });
});
