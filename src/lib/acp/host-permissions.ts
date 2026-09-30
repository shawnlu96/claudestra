/** 权限等待属于宿主请求：内部引导轮不能让 owner 批准不可见回合的动作。 */
export class HostPermissions {
  private seq = 0;
  private readonly pending = new Map<string, {
    frame: Record<string, unknown>; resolve: (option: string | null) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  constructor(private channelId: string, private hostId: string, private send: (f: Record<string, unknown>) => boolean,
    private log: (s: string) => void, private timeout: () => number) {}
  get size(): number { return this.pending.size; }
  ids(): IterableIterator<string> { return this.pending.keys(); }
  frames(): Record<string, unknown>[] { return [...this.pending.values()].map((p) => p.frame); }
  ask(card: unknown, internal: boolean): Promise<string | null> {
    if (internal) { this.log("内部引导轮请求权限：自动拒绝，不向 owner 出卡"); return Promise.resolve(null); }
    const permId = `${this.hostId}-${++this.seq}`;
    const frame = { channelId: this.channelId, type: "acp_permission", permId, card };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.end(permId, null, "等太久没人答"), this.timeout());
      this.pending.set(permId, { frame, resolve, timer });
      if (!this.send(frame)) this.log(`bridge 不在：权限请求 ${permId} 等登记上了再出卡`);
    });
  }
  end(id: string, option: string | null, why?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(option);
    if (why) {
      this.log(`权限请求 ${id} ${why}：按取消回适配器、撤卡`);
      this.send({ channelId: this.channelId, type: "acp_permission", permId: id, gone: why });
    }
    return true;
  }
}
