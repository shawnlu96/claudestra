/**
 * lib/shell-readonly.ts：第 1 轮常规审查（T14f）的 198 条分类探针（reviews/T14f-r1-work/probe2.ts），bash / zsh 真跑核对过预期。
 * 会写的一条都不能判成只读；只读的除了下面 KNOWN_FP（判成写只是多推一轮）都要判对。
 * 「ls\trm」没收：它是列出一个叫 rm 的文件，本来就是只读，探针预期写反了。
 */
import { describe, expect, test } from "bun:test";
import { isReadOnlyBash } from "../src/lib/shell-readonly.js";

const W = true, R = false;
const cases: [string, boolean][] = [
  // IFS
  ["rm${IFS}-rf${IFS}x", W], ["rm$IFS-rf$IFS/x", W], ["ls${IFS}-la", R], ["find . ${IFS}-delete", W],
  // eval/xargs/env/sh
  ["eval 'rm -rf x'", W], ["eval \"ls\"", R], ["ls | xargs rm", W], ["xargs -I{} ls {}", R], ["env -S 'rm -rf x'", W], ["env rm x", W],
  ["sh -c 'rm x'", W], ["bash -c \"echo 'a' && rm x\"", W], ["bash -c 'ls'", R], ["zsh -c ls", R],
  // functions / alias
  ["f(){ rm x; }; f", W], ["ls () ( rm -rf x ); ls", W], ["ls () { rm -rf x; }; ls", W], ["function ls { rm x; }; ls", W], ["alias ls='rm -rf x'", W],
  ["cat () ( rm -rf x ) ; cat f", W],
  // substitution
  ["echo `rm x`", W], ["echo $(rm x)", W], ["echo \"$(rm x)\"", W], ["echo $(( $(rm -rf x) ))", W], ["echo $(( `rm -rf x` ))", W],
  ["echo $((1+2))", R], ["[[ 1 -eq 'x[$(touch pwn)]' ]]", W], ["test -v 'a[$(touch pwn)]'", W], ["printf -v 'a[$(touch pwn)]' 1", W],
  ["ls =(rm -rf x)", W], ["ls *(e:'rm -rf x':)", W], ["cat <(ls)", R],
  // redirects
  ["ls > f", W], ["ls >> f", W], ["ls | tee f", W], ["ls 2> f", W], ["ls 2>&1", R], ["ls 2>/dev/null", R], ["ls <> f", W], ["ls 3>f", W], ["ls >&2", R],
  ["ls >&f", W], ["ls {fd}>f", W], ["ls &>>f", W],
  // heredoc
  ["cat <<EOF > f\nx\nEOF", W], ["cat <<EOF\nx\nEOF\nrm y", W], ["bash <<EOF\nrm -rf x\nEOF", W], ["cat <<'EOF'\n$(rm x)\nEOF", R],
  ["cat <<EOF\n$(rm x)\nEOF", W], ["echo $[1<<X]\nrm -rf x\nX]", W], ["cat <<-EOF\n\tx\n\tEOF\nrm y", W], ["cat <<EOF; rm y\nbody\nEOF", W],
  // separators
  ["ls; rm x", W], ["ls && rm x", W], ["ls || rm x", W], ["ls | rm x", W], ["ls & rm x", W], ["ls |& rm x", W], ["ls\nrm x", W],
  ["echo 'a;rm x'", R], ["echo \"a && rm\"", R], ["ls\\\n; rm x", W], ["r\\\nm x", W], ["l\\\ns", R],
  // prefixes
  ["command rm x", W], ["builtin cd x", W], ["exec rm x", W], ["nice rm x", W], ["nice -n 5 rm x", W], ["time rm x", W], ["time -p ls", R],
  ["sudo rm x", W], ["timeout 5 rm x", W], ["timeout -s KILL 5 ls", R], ["LANG=C rm x", W], ["TZ=x ls", R], ["nohup rm x", W], ["stdbuf -o0 rm x", W],
  // path names
  ["/bin/rm x", W], ["./x", W], ["/bin/ls", R], ["\\rm x", W], ["'rm' x", W],
  // git
  ["git -c alias.x='!rm -rf y' x", W], ["git config alias.x '!rm x'", W], ["git config --get user.name", R], ["git config --list", R],
  ["git config --get x --global y", W], ["git grep -Orm -e foo", W], ["git grep --open-files-in-pager=rm foo", W], ["git fetch --upload-pack='rm x' origin", W],
  ["git fetch origin", R], ["git fetch --prune origin", R], ["git -C /x status", R], ["git --git-dir=/x log", R], ["git --exec-path=/x status", W],
  ["git branch -ld x", W], ["git tag -d v1", W], ["git stash drop", W], ["git reflog expire --all", W], ["git worktree remove x", W],
  ["git diff --ext-diff", W], ["git log -p", R], ["git remote -v", R], ["git remote prune origin", W],
  // find
  ["find . -delete", W], ["find . -exec rm {} \;", W], ["find . -execdir rm {} +", W], ["find . -ok rm {} \;", W], ["find . $'-delete'", W],
  ["find . {-delete,-print}", W], ["find . ${X:--delete}", W], ["find . -name '*.ts'", R], ["find . -fprint0 f", W],
  // sed / awk
  ["sed -i s/a/b/ f", W], ["sed -I '' s/a/b/ f", W], ["sed -i.bak s/a/b/ f", W], ["sed --in-place s/a/b/ f", W], ["sed -n '1w out' f", W],
  ["sed -n 's/a/b/w out' f", W], ["sed -n '$w out' f", W], ["sed 's/.*/rm x/e' f", W], ["sed -n wout f", W], ["sed -e 1d f", R], ["sed -n 1,5p f", R],
  ["sed $'-i' s/a/b/ f", W], ["awk 'BEGIN{system(\"rm x\")}'", W], ["awk '{print > \"f\"}' x", W], ["awk -f s.awk x", W], ["awk '{print $1}' f", R],
  // interpreters
  ["python -c 'import os; os.remove(\"x\")'", W], ["python3 -c 'print(1)'", R], ["node -e 'require(\"fs\").rmSync(\"x\")'", W], ["perl -e 'unlink x'", W],
  // others in ALWAYS_READ that can write
  ["xxd f out", W], ["xxd -r in out", W], ["tree -o out", W], ["less -o log f", W], ["ls | less -olog", W], ["file -C -m m", W], ["hostname evil", W],
  ["sort ${X:--o} out in", W], ["sort {-o,out} in", W], ["sort --compress-program=rm in", W],
  // tmux
  ["tmux display-message -p x \; kill-server", W], ["tmux list-sessions ';' send-keys -t a 'rm -rf ~' Enter", W], ["tmux display -p '#(touch pwn)'", W],
  ["tmux capture-pane -p -t a", R],
  // gh / curl
  ["gh api -iXDELETE repos/x/y", W], ["gh api -X GET repos/x -f a=b", W], ["gh api graphql -f query=mutation", W], ["gh api repos/x --method=GET", R],
  ["curl -D h http://x", W], ["curl --dump-header h http://x", W], ["curl -c jar http://x", W], ["curl --cookie-jar jar http://x", W],
  ["curl --trace t http://x", W], ["curl --trace-ascii t http://x", W], ["curl --stderr e http://x", W], ["curl --libcurl c http://x", W],
  ["curl --etag-save e http://x", W], ["curl -w '%output{f}' http://x", W], ["curl -s http://x", R], ["curl -sSfL http://x | jq .", R],
  // bun/npm
  ["bun run build", W], ["bun test", R], ["npm run check", R],
  // misc read-only that may be misjudged as write
  ["ls -la | grep x | wc -l", R], ["git log --oneline | head", R], ["ps aux | grep bun", R], ["cat f | jq -r '.a' | sort | uniq -c", R],
  ["for f in *.ts; do wc -l $f; done", R], ["if [ -f x ]; then cat x; fi", R], ["while read l; do echo $l; done < f", R], ["echo a | xargs echo", R],
  ["git status && git diff --stat", R], ["npx tsc --noEmit", R], ["bun run typecheck", R], ["grep -rn foo src | head -20", R], ["sleep 5; gh pr checks 1", R],
  ["test -f x && echo y", R], ["[ -d x ] || echo n", R], ["cd /x; git log -1", R], ["export X=1; ls", R], ["X=$(git rev-parse HEAD); echo $X", R],
  ["which bun node", R], ["date +%s", R], ["env", R], ["printenv PATH", R], ["tail -f log", R], ["/usr/bin/git status", R], ["git -P log", R],
  ["git --no-pager diff", R], ["gh pr view 1 --json state -q .state", R], ["sqlite3 db 'select 1'", R], ["ls ~/x", R], ["du -sh * | sort -h", R],
];

/** 判成写的只读命令：认不出的解释器 / eval / 进程替换 / 变量赋值，保守按写算 */
const KNOWN_FP = new Set([
  "ls${IFS}-la", "eval \"ls\"", "xargs -I{} ls {}", "bash -c 'ls'", "zsh -c ls", "cat <(ls)", "python3 -c 'print(1)'", "echo a | xargs echo",
  "export X=1; ls", "X=$(git rev-parse HEAD); echo $X", "sqlite3 db 'select 1'",
]);

describe("T14f 第 1 轮审查的分类探针", () => {
  test("会写的一条都不判成只读", () => {
    expect(cases.filter(([c, w]) => w && isReadOnlyBash(c)).map(([c]) => c)).toEqual([]);
  });
  test("只读的判对（KNOWN_FP 以外）", () => {
    expect(cases.filter(([c, w]) => !w && !isReadOnlyBash(c) && !KNOWN_FP.has(c)).map(([c]) => c)).toEqual([]);
  });
  test("截断的 heredoc、算术 / 不带引号的 heredoc 里的命令替换、$[ 里的 <<", () => {
    expect(isReadOnlyBash("cat <<EOF\nx\n")).toBe(false);
    expect(isReadOnlyBash("cat <<EOF")).toBe(false);
    expect(isReadOnlyBash("echo $(( $(touch P) ))")).toBe(false);
    expect(isReadOnlyBash("cat <<EOF\n$(touch P)\nEOF")).toBe(false);
    expect(isReadOnlyBash("cat <<'EOF'\n$(touch P)\nEOF")).toBe(true);
    expect(isReadOnlyBash("echo $[1<<X]\nrm -rf x\nX]")).toBe(false);
  });
});
