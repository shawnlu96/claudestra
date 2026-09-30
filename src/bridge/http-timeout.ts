/** /clear 需要等引导与持久化；其它请求保持 30s，不能给所有慢连接扩大预算。 */
export function scopeHttpTimeout(req: Request, server: { timeout(req: Request, seconds: number): void }): void {
  const clear = req.method === "POST" && /^\/api\/v1\/agents\/[^/]+\/clear$/.test(new URL(req.url).pathname);
  server.timeout(req, clear ? 240 : 30);
}

export type HttpServer = {
  requestIP(req: Request): { address: string } | null;
  upgrade(req: Request, options?: { data?: unknown }): boolean;
  timeout(req: Request, seconds: number): void;
};
