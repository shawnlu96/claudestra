# 台账同步第3轮验证证据

历史记录：hlc_probe 中手写构造的 received/later 不作为当前界内因果证明；当前收发/边界验证见 [第4轮证据](ledger-sync-r4-evidence.md)。

复现测试：hlc-bound、authority-marker、event-class-ambiguity、authority-operation-sequence。
这是读取设计契约后执行的合成参考模型，使用内存 SQLite；不是生产实现测试。
用 `--expect red` 在修订前运行，三项新反例必须违反不变量；已在第2轮修正的权威切模式语义应保持 GREEN。
修改设计后用 `--expect green`，四项都必须成立，另用错误路由突变确认状态机测试会变 RED。
策略从设计稿的 `ledger-sync-safety-v1` JSON 块解析；旧稿没有该契约时采用旧稿的未界定行为。

```python
import argparse, json, re, sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--expect', choices=['red', 'green'], required=True)
parser.add_argument('--design', default='docs/design/ledger-sync.md')
args = parser.parse_args()
doc = Path(args.design).read_text()
m = re.search(r'```json ledger-sync-safety-v1\n(.*?)\n```', doc, re.S)
policy = json.loads(m.group(1)) if m else {}
sticky = policy.get('centerAuthoritySticky', '一旦采用 center，本机任意模式都不能恢复本地定序权' in doc)
unsafe_routing = False

class Model:
    def __init__(self):
        self.mode, self.authority, self.stage = 'on', 'center', 'review'
        self.marker = 'center' if policy.get('markerOutsideLedger') else None
        self.outbox, self.actions, self.local_mutations = [], [], []
    def restore_pre_migration(self):
        self.stage, self.authority = 'review', 'local'
    def set_mode(self, mode):
        self.mode = mode
    def command(self, target, online, center_stage):
        authority = (self.marker or 'unknown') if policy.get('markerOutsideLedger') else self.authority
        if authority == 'unknown':
            return 'denied'
        if sticky and not unsafe_routing and authority == 'center':
            if not online:
                self.outbox.append((self.stage, target))
                return 'pending'
            if self.stage != center_stage:
                self.stage = center_stage
                return 'rejected'
            self.stage = target
            return 'center-accepted'
        if self.mode in ['observe', 'off']:
            self.stage = target
            self.local_mutations.append(target)
            if target == 'merge':
                self.actions.append('merge')
            return 'local'
        self.outbox.append((self.stage, target))
        return 'pending'
    def drain(self, center_stage):
        result = []
        for expected, target in self.outbox:
            if expected != center_stage:
                result.append('rejected')
            else:
                center_stage = target
                result.append('center-accepted')
        self.outbox.clear()
        self.stage = center_stage
        return result

def hlc_probe():
    now, max_physical = 1000000, (1 << 48) - 1
    limit = min(now + policy.get('maxFutureMs', max_physical),
                max_physical - policy.get('physicalReserveMs', 0))
    clock, materialized, rejected = (now, 0), [], []
    for physical in [now + 86400000, max_physical]:
        if physical > limit:
            rejected.append(physical)
        else:
            clock = (physical, 1)
            materialized.append(physical)
    safe = len(rejected) == 2 and clock == (now, 0) and not materialized
    if policy:
        # Accepted bounded skew still permits a strictly later causal write.
        remote = (now + 30000, 65535)
        received = (remote[0] + 1, 0)
        later = (received[0], 1)
        safe = safe and later > remote and later[0] <= limit
    return safe

def marker_probe():
    model = Model()
    model.restore_pre_migration()
    model.set_mode('off')
    result = model.command('merge', False, 'fix')
    missing = Model()
    missing.restore_pre_migration()
    missing.marker = None
    missing.set_mode('off')
    absent = missing.command('merge', False, 'fix')
    return result == 'pending' and not model.actions and not model.local_mutations and absent == 'denied'

def event_probe():
    db = sqlite3.connect(':memory:')
    db.execute('create table events(dedupKey text unique, origin text)')
    failed = False
    for origin in ['a', 'b']:
        raw = 'import:inbox:hash'
        key = json.dumps(['sync-merge-v1', 'p', origin, raw], separators=(',', ':')) if policy.get('mergeStorageKey') == 'namespaced' else raw
        try:
            db.execute('insert into events values (?,?)', (key, origin))
        except sqlite3.IntegrityError:
            failed = True
    count = db.execute('select count(*) from events').fetchone()[0]
    db.close()
    return not failed and count == 2

def sequence_probe():
    all_safe = True
    for mode in ['on', 'observe', 'off']:
        model = Model()
        model.set_mode(mode)
        before = model.command('merge', False, 'review')
        center_stage = 'fix'  # A different member gets a center verdict during disconnection.
        replies = model.drain(center_stage)
        all_safe = all_safe and before == 'pending' and replies == ['rejected'] and model.stage == 'fix'
        all_safe = all_safe and not model.actions and not model.local_mutations
    return all_safe

results = {'hlc-bound': hlc_probe(), 'authority-marker': marker_probe(),
           'event-class-ambiguity': event_probe(), 'authority-operation-sequence': sequence_probe()}
for name, ok in results.items():
    print(name + ': ' + ('GREEN' if ok else 'RED'))
    expected = args.expect == 'green' or name == 'authority-operation-sequence'
    assert ok == expected, name
if args.expect == 'green':
    unsafe_routing = True
    assert not sequence_probe()
    print('authority-operation-sequence: MUTATED ROUTING RED')
```

## 可复核输出

同一最终脚本读取基准 `c933f53975eba278299eed352131794742c7331e` 的设计稿（git show 导出临时文件）并传 `--expect red --design <file>`：

```text
hlc-bound: RED
authority-marker: RED
event-class-ambiguity: RED
authority-operation-sequence: GREEN
```

读取修订稿并传 `--expect green`：

```text
hlc-bound: GREEN
authority-marker: GREEN
event-class-ambiguity: GREEN
authority-operation-sequence: GREEN
authority-operation-sequence: MUTATED ROUTING RED
```

两次都退出 0，原因是各自断言结果与指定 red/green 预期一致；不是把失败误写成成功。
三项新反例在修改设计前已确认红灯；最终同一脚本对基准复核这三项 RED、对修订稿复核 GREEN。
权威切模式已在第2轮修对，基准也应 GREEN；最初探针把缺少 JSON 参数误解成不保持中心权威，其该项 RED 不作为证据。
现按基准明确文字识别 sticky 权威，并用错误路由突变证实新操作序列测试会检出本地执行。
模型还覆盖库外 marker 丢失默认 deny；没有引入生产同步实现或证明 admission/流世代代码已存在。

## 本轮基准与构建检查

基准 `c933f53975eba278299eed352131794742c7331e` 的隔离 clone，frozen install 退出 0。
`bun test tests/sandbox-isolation.test.ts`：5 pass / 1 fail，109 expect()、66.79 秒，退出 1；
同一 restart 第二次 up 临时端口仍占用断言，未改测试/基线，未声称已豁免。
六入口 bridge/channel-server/manager/launcher/cron/setup 的 Bun build 均退出 0。

## 模型覆盖边界

HLC 模型验证上界过滤与界内后写顺序，不验证尚未实现的 admission、流世代恢复或 wire BigInt 编码。
事件模型验证全局 UNIQUE 的跨来源同 hash 反例；机械分类的完整 schema 校验仍须 SY0/SY2 实现测试。
权威模型执行切模式/离线申请/中心改变/回放/旧库恢复/缺 marker 操作；不模拟真实磁盘原子写或实际路由。

## 本轮 strict 检查最终结果

`GUARD_STRICT=1 bun run check`：typecheck 通过；11771 pass / 20 skip / 1 fail，
945 文件、213527 expect()、4 snapshots、591.98 秒，check 退出 1，组合命令未继续执行 guard。
唯一失败 `tests/sandbox-isolation.test.ts`：restart 第二次 up 临时端口占用，用例耗时 61454.57ms。
基准同文件同断言已复现（66.79 秒）；没有别的等待型超时失败，未声称该端口错误获得豁免。
另跑 `GUARD_STRICT=1 bun run guard` 退出 0；六入口 build、节点 glob、diff --check 通过。
glob 实跑：10 节点，171 对，overlaps=none，非 SY7 匹配现有文件数 0。
原始日志在临时目录 `i28-sync1-r3-check.log` 与 `i28-sync1-r3-base-sandbox.log`。
PR head 的全量必过项仍由 CI/PM 合并闸核对；无 disputes，未合并、部署或发布。
