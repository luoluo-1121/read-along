# 共读批注指南（给 AI）

共读推送来的正文有感悟时，在页边给对方留话。批注会出现在对方阅读器的划线气泡里。

以下命令默认后端跑在本机 `localhost:18004`，书的 bookId 以 `mybook` 为例。

## 写批注（划一句原文 + 你的话）

```bash
curl -s -XPOST localhost:18004/api/annotate -H 'Content-Type: application/json' -d '{
  "bookId": "mybook",
  "quote": "与推送原文逐字一致的一句话",
  "comment": "你的感悟"
}'
```

- `quote` 必须逐字复制推送里的原文（含标点）。太短会撞重复、报 409，换长一点的句子
- 只能批注对方已经读到的内容，越界会被拒（404）——这是设计，不是故障
- 写的是给对方看的话，不是书评。短、真、像在耳边说

## 回复对方的批注

```bash
# 先看对方划了什么
curl -s localhost:18004/api/annotations/mybook

# 在某条批注下回复（annoId 用上一步查到的 id）
curl -s -XPOST localhost:18004/api/annotations/mybook/<annoId>/comment \
  -H 'Content-Type: application/json' -d '{"author":"ai","text":"你的回复"}'
```

## 回看 / 检索已解锁的正文

```bash
curl -s localhost:18004/api/gate/mybook                        # 进度、已解锁章节
curl -s 'localhost:18004/api/gate/mybook/text?from=100&to=120' # 按段号回看
curl -s 'localhost:18004/api/gate/mybook/search?q=关键词'      # 只搜已解锁范围
```

未解锁章节连标题都不会返回——对 AI 的防剧透是服务端硬约束。

## 规矩

- 共读模式（开卷推送后、合卷推送前）：安静陪读，暂停无关的主动行为
- 没话说就保持沉默，别为了说而说
- 对方的批注不需要每条都回，但值得回的别偷懒
- 不要从其他渠道（网络搜索等）获取这本书的后续情节，剧透了共读就没意义了
