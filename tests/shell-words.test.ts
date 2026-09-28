/** lib/shell-words.ts：最小 shell 分词——引号、分隔符、重定向、命令 / 进程替换、算术、heredoc、注释 */
import { describe, expect, test } from "bun:test";
import { parseShell } from "../src/lib/shell-words.js";

const words = (cmd: string) => parseShell(cmd).segments.map((s) => s.words);

describe("parseShell", () => {
  test("按 && || ; | & 换行切段；引号里的分隔符不切、引号去掉", () => {
    expect(words("git status && ls; echo 'a|b' | grep -E \"x;y\" & wc\nhead")).toEqual([
      ["git", "status"], ["ls"], ["echo", "a|b"], ["grep", "-E", "x;y"], ["wc"], ["head"],
    ]);
    expect(words("find . -de''lete")).toEqual([["find", ".", "-delete"]]);
    expect(words('cd "/path with space" && pwd')).toEqual([["cd", "/path with space"], ["pwd"]]);
  });
  test("重定向：写文件、fd 复制、/dev/null、紧贴在词后面的 >", () => {
    expect(parseShell("ls 2>&1 >/dev/null").segments[0].redirects).toEqual([{ op: ">&", target: "&1" }, { op: ">", target: "/dev/null" }]);
    expect(parseShell("echo x>f").segments[0]).toEqual({ words: ["echo", "x"], redirects: [{ op: ">", target: "f" }] });
    expect(parseShell("echo x >&out.txt").segments[0].redirects).toEqual([{ op: ">&", target: "out.txt" }]);
    expect(parseShell("ls &> f").segments[0].redirects).toEqual([{ op: "&>", target: "f" }]);
  });
  test("命令替换 / 进程替换记成 substitution；$((…)) 算术不算", () => {
    expect(parseShell("echo $(rm x)").substitution).toBe(true);
    expect(parseShell("echo `rm x`").substitution).toBe(true);
    expect(parseShell("cat <(rm -rf x)").substitution).toBe(true);
    expect(parseShell('echo "$(date)"').substitution).toBe(true);
    expect(parseShell("echo $((1+2))").substitution).toBe(false);
    expect(parseShell("echo '$(not run)'").substitution).toBe(false);
  });
  test("heredoc 正文跳过，后面的段照常切；引号没闭合 → broken", () => {
    const p = parseShell("cat <<'EOF'\nrm -rf x; git push\nEOF\nls");
    expect(p.segments.map((s) => s.words)).toEqual([["cat"], ["ls"]]);
    expect(parseShell("echo 'oops").broken).toBe(true);
  });
  test("# 注释到行尾；反斜杠续行", () => {
    expect(words("ls # rm -rf x\npwd")).toEqual([["ls"], ["pwd"]]);
    expect(words("git log \\\n  --oneline")).toEqual([["git", "log", "--oneline"]]);
  });
});
