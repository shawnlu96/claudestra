/** Validate the process result before trusting stdout; a timeout must not look like loggedIn:true. */
export async function claudeAuthOutput(proc: { stdout: ReadableStream; exited: Promise<number>; kill(signal: number): void },
  timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { proc.kill(9); reject(new Error("核对本机 Claude 登录超时")); }, timeoutMs);
  });
  const output = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([text, exit]) => {
    if (exit !== 0) throw new Error("claude auth status 非零退出，核对本机 Claude 登录失败");
    return text;
  });
  try { return await Promise.race([output, timeout]); } finally { clearTimeout(timer); }
}
