# 台账同步第2轮验证证据

历史验证记录；其中 1 天漂移照收与直接赋值的 rollback 模型已被 [第3轮证据](ledger-sync-r3-evidence.md) 替代，不能作为当前契约通过依据。

仅为合成契约模型验证，不是尚未实现的同步代码测试。内存 SQLite 与字典，不接生产。
先运行旧规则的红灯断言，再修设计并运行新规则；脚本检查两者，不把预期旧失败当作脚本失败。

复现测试：event-claims、rollback-authority、cross-stream-order、hlc-skew。

```python
import sqlite3

def check(name, old, new):
    try:
        assert old
    except AssertionError:
        print(name + ': OLD RED (invariant violated)')
    else:
        raise AssertionError(name + ': old counterexample did not fail')
    assert new
    print(name + ': NEW GREEN')

# Claim grants: distinct origins do not make the business key distinct.
key = 'autostart:F:N:arm'
old_claims = [('a', key), ('b', key)]
db = sqlite3.connect(':memory:')
db.execute('create table grants(project text, key text, origin text, unique(project,key))')
for origin in ['a', 'b']:
    db.execute('insert or ignore into grants values (?,?,?)', ('p', key, origin))
check('event-claims', len(old_claims) == 1,
      db.execute('select count(*) from grants').fetchone()[0] == 1)

# After authority was adopted, changing view mode cannot change authority.
center_stage = 'fix'
old_local_stage, old_merge_actions = 'merge', 1
def route(authority, mode):
    if authority == 'center':
        return 'center-command'
    return 'local-command'
new_routes = [route('center', mode) for mode in ['on', 'observe', 'off']]
new_local_stage, new_merge_actions = center_stage, 0
check('rollback-authority', old_local_stage == center_stage and old_merge_actions == 0,
      all(r == 'center-command' for r in new_routes) and
      new_local_stage == center_stage and new_merge_actions == 0)

# Missing target: retain the log and retry materialization after the create result.
old_rows, new_rows, pending = {}, {}, []
entry = ('T', 'title', 'edited')
if entry[0] in old_rows:
    old_rows[entry[0]][entry[1]] = entry[2]
pending.append(entry)
old_rows['T'] = {'title': 'initial'}
new_rows['T'] = {'title': 'initial'}
for target, field, value in pending:
    new_rows[target][field] = value
pending.clear()
check('cross-stream-order', old_rows['T']['title'] == 'edited',
      new_rows['T']['title'] == 'edited' and not pending)

# Standard HLC receive followed by send exceeds the observed future timestamp.
wall, remote = 1000, (1000 + 86400000, 0)
old_write = (wall, 1)
received = (max(wall, remote[0]), remote[1] + 1)
new_write = (received[0], received[1] + 1)
check('hlc-skew', old_write > remote, new_write > remote)
db.close()
```

执行方式：提取上面的 Python 块，以 `env -i` 最小环境运行 `python3`。
模型结果不证明中心实现、网络协议或现有授予写权代码已经被改造。

## 合成模型确切输出

```text
event-claims: OLD RED (invariant violated)
event-claims: NEW GREEN
rollback-authority: OLD RED (invariant violated)
rollback-authority: NEW GREEN
cross-stream-order: OLD RED (invariant violated)
cross-stream-order: NEW GREEN
hlc-skew: OLD RED (invariant violated)
hlc-skew: NEW GREEN
```

脚本退出 0；旧规则四个不变量断言均触发 AssertionError（捕获并标 RED），新模型四个断言均通过。

## 基准复核

隔离 clone checkout 基准 `4d0752f919689d59a3bc2a0173daf4287efaf652`，
`bun install --frozen-lockfile` 退出 0；仅复跑 `tests/sandbox-isolation.test.ts`：
5 pass / 1 fail，109 expect()，70.25 秒，退出 1。
与前轮相同的 restart 第二次 up 断言失败：临时端口仍占用，期望 0、实际 1。
这是基准亦可复现的环境/沙箱生命周期失败，不是新设计模型失败；没有把它改称已通过或自动豁免。

## 规划与构建验证

- 节点 glob 脚本实跑：`sy nodes=10 checked pairs=171 overlaps=none`，非 SY7 匹配现有文件数 0。
- bridge、channel-server、manager、launcher、cron、setup 六入口 Bun build 全部退出 0；产物仅在临时目录。
- `GUARD_STRICT=1 bun run guard` 退出 0，严格模式；未改 baseline 或 guard 配置。
- 四项修改分别落 §2.2.1、§4.4、§3.2、§1.3，并追加 SY0/SY1/SY2/SY7 验收。
- 未改私有计划、生产状态、台账或凭据；无 disputes。仍由 PM 核 CI 合并闸与代交付。

## 本轮 strict 全量检查结果

`GUARD_STRICT=1 bun run check`：typecheck 通过；测试 11771 pass / 20 skip / 1 fail，
945 文件、213527 expect()、4 snapshots、607.51 秒，check 退出 1，组合命令未继续执行 guard。
唯一失败文件 `tests/sandbox-isolation.test.ts`，restart 第二次 up 报临时端口占用，
该用例耗时 61940.14ms；基准相同文件同断言也失败（见上节）。
本轮没有等待型超时的其他失败，不声称上述端口失败已获得豁免。
因此另跑严格 guard 且通过；全量必过项最终由 PR head CI 与 PM 合并闸核对。
原始日志保存在临时目录 `i28-sync1-r2-check.log` 与 `i28-sync1-r2-base-sandbox.log`。
