# 记忆索引体积提示(agents-MEMIDX1)

Claude Code 每个会话都会自动注入工作目录 auto-memory 目录下的 `MEMORY.md`(记忆索引)。索引越写越长,每个会话、每次压缩之后都要重新付一遍这些 token。本功能在 SessionStart hook 里量一下这份文件的字节数,超过阈值就指出超了多少、哪几行最长。

它只做提示:

- **不改任何记忆文件。** `MEMORY.md` 和记忆正文是用户的文件,删改要用户同意。本功能没有裁剪、摘要、恢复这类动作,对记忆目录只读。
- **不替代自动注入。** 索引照旧由 Claude Code 注入;提示本身也不会让当前会话少花 token,它只帮人找到膨胀在哪。

## 在哪里跑

`src/hooks/recall-hook.ts`(SessionStart:startup / resume / clear / compact)。subagent(带 `agent_id`)照旧整个跳过。检查是本地同步读,排在 mem0 recall 之前做完,recall 卡到超时也不影响它;提示留到最后才写,所以总在注入内容的末尾。

目录用 `memoryDir(cwd)`(`src/lib/session-recall.ts`)解析,与 HANDOFF 用的是同一个。

## 量什么(`src/lib/memory-index-check.ts`,纯函数)

`checkMemoryIndex(raw, maxBytes)` 的输入是文件的原始字节,不先解码:

- 总量 = 磁盘上的字节数。**等于阈值不算超**,多 1 字节就超 1。
- 行按 LF 切,行尾的 CR 算换行符的一部分;行长是该行的 UTF-8 字节数,不含换行符。空行是 0 字节的一行,末行没有换行也算一行,文件末尾的换行不多算一个空行。
- 最长的 3 行:字节数降序,相同长度行号小的在前;文件不足 3 行就只列那么多。

`memoryIndexNotice(check)` 在超额时给出一行中文,没超返回 `null`:

```
⚠ 记忆索引 MEMORY.md 共 8193 字节,超过 8192 字节阈值 1 字节;最长行:第 1 行(5000 字节)、第 2 行(3191 字节)。只是提示,不会自动改动;要精简请先让用户确认。
```

提示和记录里只有数字和行号,不带行的内容——复述正文等于把长索引再注入一遍。

## 开关:`on` / `observe` / `off`(机器级,缺省 `observe`)

配置在状态目录的 `memory-index-mode.json`,只有机器级一份,不分项目:

```json
{ "mode": "observe", "maxBytes": 8192 }
```

| 档 | stdout | 状态目录 |
|---|---|---|
| `off` | 与没有本功能时逐字相同 | 不检查,不写任何东西 |
| `observe` | 与没有本功能时逐字相同 | 落一份最近检查记录 |
| `on` | 超额时末尾多且只多一行提示 | 检查,但不写任何东西 |

- 文件不存在 → `observe`,阈值 8192。字段缺省同理(只写 `maxBytes` 就是 observe + 该阈值)。
- 文件读不出、不是普通文件(目录、FIFO、设备、悬空软链)、超过 64KB、不是 JSON 对象、`mode` 不是三档之一、`maxBytes` 不是正整数 → 按 `off`。拿不准时选与改前完全一致的那一档,不退回 observe。
- 读开关不会卡住 hook:非阻塞打开,在打开的句柄上核对是普通文件后才读(无写者的 FIFO 用普通同步读会一直等到 hook 被外层超时杀掉,连 recall 一起丢)。`MEMORY.md` 也是这样读的。
- 这个文件由人手改;本功能不写它,也没有对应的 manager 命令。

## 最近检查记录

只有 `observe` 档写。`<状态目录>/memory-index-check/<项目 slug>.json`,每个工作目录一份,覆盖式(slug 即 `projectSlug(cwd)`)。按目录分文件是为了让同时启动的多个会话各写各的,不必读改写同一份。

```json
{
  "at": 1791716513697,
  "cwd": "/path/to/project",
  "file": "/Users/x/.claude/projects/-path-to-project/memory/MEMORY.md",
  "source": "startup",
  "mode": "observe",
  "totalBytes": 9120,
  "maxBytes": 8192,
  "overBytes": 928,
  "longest": [{ "line": 14, "bytes": 412 }, { "line": 3, "bytes": 380 }, { "line": 27, "bytes": 377 }]
}
```

没超也会记(`overBytes: 0`),这样能看出索引离阈值还有多远。

写记录不跟随软链,落点只会在状态目录里:

- `memory-index-check` 必须是状态目录下的真目录;它若是软链(指到别处,比如记忆目录),这次不写。
- 记录文件位置上若已经是一个软链(指向 `MEMORY.md` 或别的用户文件),被换掉的是链接本身,链接的目标一个字节、mtime 都不动。

## 失败怎么办

hook 的铁律不变:永远 exit 0,不拖累会话启动。`MEMORY.md` 不存在、无权读、不是普通文件(目录、FIFO),或者检查中途出任何异常,都当这次没检查:不提示、不落记录。`on` 档不写状态目录,记录写不写得进去与提示无关。检查模块是动态加载的,它或它依赖的路径模块加载失败时,HANDOFF 和 recall 照常注入。

## 怎么用

1. 默认 `observe` 跑几天,看 `memory-index-check/` 下各项目的 `overBytes` 和 `longest`。
2. 需要会话里直接看到提醒时,把 `mode` 改成 `on`(此后不再更新记录,要看数字再切回 `observe`)。
3. 要缩索引,拿着行号去看那几行,向用户提具体的修改再动;本功能不是删改记忆文件的授权。

测试:`tests/memory-index-check.test.ts`(纯逻辑)、`tests/memory-index-check-hook.test.ts`(起真实 hook 子进程,合成数据 + 临时目录)。
