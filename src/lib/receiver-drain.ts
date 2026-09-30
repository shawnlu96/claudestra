/** 新接收端为迁移提供排空闸；旧接收端不认握手时，bridge 必须保留会话而非猜测已经送达。 */
export class ReceiverDrain {
  private active = new Set<Promise<unknown>>();
  private queued: [string, Record<string, string>][] = [];
  private token = "";
  private timer?: ReturnType<typeof setTimeout>;
  private failed = false;
  constructor(private send: (content: string, meta: Record<string, string>) => Promise<unknown>, private log: (s: string) => void) {}
  deliver(content: string, meta: Record<string, string>): void {
    if (this.token) { this.queued.push([content, meta]); return; }
    const p = Promise.resolve().then(() => this.send(content, meta));
    this.active.add(p);
    void p.catch((e) => { this.failed = true; this.log(`接收端消息投递失败：${String(e)}`); }).finally(() => this.active.delete(p));
  }
  frame(m: Record<string, any>, reply: (frame: Record<string, unknown>) => void): boolean {
    if (m.type === "migration_resume") {
      if (m.token === this.token) this.resume();
      return true;
    }
    if (m.type !== "migration_drain") return false;
    this.token = String(m.token);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.resume(), 240_000);
    this.timer.unref?.();
    void Promise.allSettled([...this.active]).then(() => {
      if (this.token === m.token) reply({ type: "acp_migration_drained", id: m.token, ok: !this.failed && !this.queued.length });
    });
    return true;
  }
  private resume(): void {
    this.token = "";
    clearTimeout(this.timer);
    for (const [content, meta] of this.queued.splice(0)) this.deliver(content, meta);
  }
}
