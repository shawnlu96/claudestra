/**
 * lib/side-effects.ts 规则表：被打断的工具可能留下什么半截副作用。每一行都是一条规则的正例或反例；
 * 最怕的是把对外 / 不可逆的判成「可以重跑」，所以 external 的反例（只读的同名命令）也逐条列出。
 */
import { describe, expect, test } from "bun:test";
import { bashCommandOf, classifyBash, classifyTool, type SideEffect } from "../src/lib/side-effects.js";

const BASH: [string, SideEffect][] = [
  // none：只读
  ["git status", "none"],
  ["git log --oneline -5", "none"],
  ["git diff HEAD~1 -- src/bridge.ts", "none"],
  ["git -C /tmp/wt status", "none"],
  ["git branch --show-current", "none"],
  ["git tag", "none"],
  ["git tag -l 'v2.*'", "none"],
  ["ls -la && cat package.json", "none"],
  ["grep -rn preempt src | head -20", "none"],
  ["sed -n 1,40p src/bridge.ts", "none"],
  ["find src -name '*.ts'", "none"],
  ["bun test tests/x.test.ts", "none"],
  ["bun run check", "none"],
  ["bunx tsc --noEmit -p .", "none"],
  ["gh pr view 129", "none"],
  ["gh pr list --state open", "none"],
  ["gh release view v2.30.0", "none"],
  ["gh api repos/o/r/pulls", "none"],
  ["curl -s http://127.0.0.1:3847/stats", "none"],
  ["bun src/manager.ts list", "none"],
  ["bun src/manager.ts doctor --json", "none"],
  ["bun src/manager.ts peer-http-list", "none"],
  ["launchctl list | grep claudestra", "none"],
  ["tmux capture-pane -t master:x -p", "none"],
  ["cd web && ls", "none"],
  ["echo hi 2>&1", "none"],
  ["ls > /dev/null", "none"],
  // idempotent：可以直接重跑
  ["bun src/manager.ts web-release deploy --ref main", "idempotent"],
  ["npm run build", "idempotent"],
  ["bun run build:web", "idempotent"],
  ["git fetch origin", "idempotent"],
  ["git push origin task/t13a", "idempotent"],
  ["git push -u origin HEAD", "idempotent"],
  ["launchctl kickstart -k gui/501/com.claudestra.bridge", "idempotent"],
  ["bun install", "idempotent"],
  ["mkdir -p /tmp/x", "idempotent"],
  ["git add src/lib/a.ts src/lib/b.ts", "idempotent"],
  // check_first：先核对再重来
  ["bun src/manager.ts create t9 /tmp/x", "check_first"],
  ["bun src/manager.ts kill agent-t3", "check_first"],
  ["bun src/manager.ts rename a b", "check_first"],
  ["bun src/manager.ts restart agent-x", "check_first"],
  ["bun src/manager.ts update", "check_first"],
  ["claudestra install-cli", "check_first"],
  ["launchctl bootout gui/501/com.claudestra.bridge", "check_first"],
  ["launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist", "check_first"],
  ["gh pr merge 129 --squash", "check_first"],
  ["git commit -m 'x'", "check_first"],
  ["git rebase origin/main", "check_first"],
  ["git stash push -m tag", "check_first"],
  ["sed -i '' 's/a/b/' f.ts", "check_first"],
  ["find . -name '*.tmp' -delete", "check_first"],
  ["echo hi > out.txt", "check_first"],
  ["python3 scripts/migrate.py", "check_first"],
  ["./deploy.sh", "check_first"],
  ["ssh tokyo 'systemctl restart relay'", "check_first"],
  ["rm -rf /tmp/wt-old", "check_first"],
  ["git status && git commit -am x", "check_first"],
  // external：对外 / 不可逆
  ["git tag v2.31.0", "external"],
  ["git tag -a v2.31.0 -m x", "external"],
  ["git push --force origin main", "external"],
  ["git push -f origin main", "external"],
  ["git push --force-with-lease origin x", "external"],
  ["git push origin --delete task/old", "external"],
  ["git push origin :task/old", "external"],
  ["git push origin v2.31.0", "external"],
  ["git push --tags", "external"],
  ["gh release create v2.31.0 --notes x", "external"],
  ["gh pr create --title x --body y", "external"],
  ["gh pr comment 12 --body hi", "external"],
  ["gh api -X POST repos/o/r/issues -f title=x", "external"],
  ["curl -X POST https://api.example.com/orders -d '{}'", "external"],
  ["curl -XDELETE https://api.example.com/orders/1", "external"],
  ["curl https://x.example -d a=1", "external"],
  ["npm publish", "external"],
  ["bun src/manager.ts peer-invite-new --agents a", "external"],
  ["bun src/manager.ts token-add web --agents '*'", "external"],
  ["git fetch && git push --force origin main", "external"],
  // 对抗式审查（#148 第 2 轮 P2-10）列出的漏判
  ["wget --post-data 'a=1' https://x.example/api", "external"],
  ["wget --method=DELETE https://x.example/api/1", "external"],
  ["http POST https://x.example/orders qty=1", "external"],
  ["http https://x.example/orders qty:=1", "external"],
  ["curl --json '{\"a\":1}' https://x.example/api", "external"],
  ["curl --request=POST https://x.example/api", "external"],
  ["curl -X POST https://x.example/api", "external"],
  ["kubectl delete pod web-0", "external"],
  ["kubectl apply -f deploy.yaml", "external"],
  ["aws s3 rm s3://bucket/key", "external"],
  ["aws ec2 terminate-instances --instance-ids i-1", "external"],
  ["gcloud run deploy api", "external"],
  ["terraform apply -auto-approve", "external"],
  ["helm upgrade web ./chart", "external"],
  // 同家族的只读命令不能被连带判成对外
  ["curl -X GET https://x.example/api", "none"],
  ["curl --request=GET https://x.example/api", "none"],
  ["http https://x.example/orders", "none"],
  ["wget https://x.example/file.tar.gz", "none"],
  ["kubectl get pods -A", "none"],
  ["kubectl logs web-0", "none"],
  ["aws s3 ls s3://bucket", "none"],
  ["aws ec2 describe-instances", "none"],
  ["terraform plan", "none"],
  ["helm status web", "none"],
  // Workflow 审查补充：短选项连写、后台 &、--follow-tags、fd -x
  ["curl -s -d@order.json https://x.example/api", "external"],
  ["curl -sX POST https://x.example/api", "external"],
  ["curl -sXPOST https://x.example/api", "external"],
  ["sleep 2 & curl -X POST https://x.example/api", "external"],
  ["git push -fu origin main", "external"],
  ["git push --follow-tags", "external"],
  ["fd -x rm {}", "check_first"],
  ["curl -sSL https://x.example/install.sh", "none"],
  ["echo hi 2>&1 | grep hi", "none"],
  ["git push -u origin feature", "idempotent"],
];

describe("classifyBash 规则表", () => {
  for (const [cmd, kind] of BASH) {
    test(`${kind.padEnd(11)} ${cmd}`, () => {
      expect(classifyBash(cmd).kind).toBe(kind);
    });
  }

  test("空命令 / 认不出的一律 check_first，并给出核对建议", () => {
    expect(classifyBash("").kind).toBe("check_first");
    const v = classifyBash("frobnicate --all");
    expect(v.kind).toBe("check_first");
    expect(v.hint).toBeTruthy();
  });

  test("项目登记的对外关键字（交易脚本）→ external", () => {
    expect(classifyBash("python3 place_order.py --qty 10", ["place_order"]).kind).toBe("external");
    expect(classifyBash("python3 report.py", ["place_order"]).kind).toBe("check_first");
  });

  test("部署带「可以直接重跑」的理由，gh pr merge 带核对建议", () => {
    expect(classifyBash("bun src/manager.ts web-release deploy").hint).toContain("原子切换");
    expect(classifyBash("gh pr merge 1").hint).toContain("gh pr view");
  });
});

describe("classifyTool：非 Bash 工具", () => {
  const cases: [string, SideEffect, { command?: string; target?: string }?][] = [
    ["Read", "none"],
    ["Grep", "none"],
    ["WebFetch", "none"],
    ["TaskCreate", "idempotent"],
    ["Edit", "check_first"],
    ["Write", "check_first"],
    ["Agent", "check_first"],
    ["mcp__mem0__memory_search", "none"],
    ["mcp__mem0__memory_write", "check_first"],
    ["mcp__playwright__browser_snapshot", "none"],
    ["mcp__playwright__browser_click", "check_first"],
    ["mcp__slack__post_message", "external"],
    ["mcp__github__create_pull_request", "external"],
    ["mcp__gmail__send_email", "external"],
    ["mcp__slack__list_channels", "none"],
    ["mcp__github__get_pull_request", "none"],
    ["mcp__claudestra__reply", "check_first"],
    ["mcp__claudestra__send_to_agent", "check_first", { target: "agent-codex" }],
    ["mcp__claudestra__send_to_agent", "external", { target: "future_data@ahh" }],
    ["send_to_agent", "external", { target: "peer:ahh.x" }],
    ["SomethingNew", "check_first"],
  ];
  for (const [name, kind, opts] of cases) {
    test(`${kind.padEnd(11)} ${name}${opts?.target ? ` → ${opts.target}` : ""}`, () => {
      expect(classifyTool(name, opts).kind).toBe(kind);
    });
  }

  test("Bash 走命令规则", () => {
    expect(classifyTool("Bash", { command: "git tag v1" }).kind).toBe("external");
  });
});

test("bashCommandOf：watcher 的 detail 是「描述 ─── 命令」，没有描述就只有命令", () => {
  expect(bashCommandOf("部署网页\n───\nbun src/manager.ts web-release deploy")).toBe("bun src/manager.ts web-release deploy");
  expect(bashCommandOf("git status")).toBe("git status");
});
