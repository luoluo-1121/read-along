# 部署指南

从零开始，在自己的 VPS 上把共读系统搭起来。本文以 cyberboss 用户为主要示例；不用 cyberboss 的话，推送桥也支持通用 webhook 模式。

## 1. 前置要求

- 一台 VPS（本文以 Debian/Ubuntu 为例），有 root 或 sudo 权限
- Node.js ≥ 18（需要内置 fetch）
- nginx（`apt install -y nginx`）
- 一个解析到这台 VPS 的域名（配 HTTPS 用，强烈建议）
- 你的 AI 需要一个「能接收文本消息的入口」：
  - **cyberboss 用户**：什么都不用额外搭。共读后端直接往 cyberboss 的系统消息队列里写，cyberboss 会把它作为系统消息注入你的 AI 的聊天线程——就像 check-in 触发那样。前提是 cyberboss 已经在这台 VPS 上跑着、且已绑定过会话（`~/.cyberboss/sessions.json` 里有 bindings）。
  - **非 cyberboss 用户**：webhook 模式，给一个能收 HTTP POST 的地址即可（见第 6 节）。

## 2. 安装

```bash
cd /opt
git clone <this-repo> read-along
cd read-along
npm install
```

目录结构：

```
read-along/
├── server.js          后端主服务（零框架，纯 Node 原生 http）
├── import-book.js     EPUB 导入工具
├── lib/
│   ├── store.js       存储层（JSON 文件 + 原子写）
│   ├── epub.js        EPUB 解析
│   └── push.js        推送桥（cyberboss 队列 / webhook）
├── web/
│   └── reader.html    前端阅读器（单文件）
└── data/              运行时自动生成：书库、进度、批注、推送日志
```

## 3. 前端与 nginx

```bash
mkdir -p /var/www/reading
cp web/reader.html /var/www/reading/
```

在你的站点配置的 `server` 块里加两段 location：

```nginx
# 前端阅读器（静态文件）
location /reading/ {
    alias /var/www/reading/;
    index reader.html;
}

# 后端 API（反代到本机服务）
location /reading/api/ {
    proxy_pass http://127.0.0.1:18004/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

然后 `nginx -t && systemctl reload nginx`。

HTTPS（一条命令）：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

> ⚠ **访问控制**：本方案没有内置登录。书和批注是私人内容，建议至少加一层 nginx Basic Auth（`htpasswd` + `auth_basic`），或把路径改成不可猜测的随机字符串（比如 `/reading-x7k2m9/`，同时改 `reader.html` 里的 `API` 常量）。AI 侧从本机直接访问 `localhost:18004` 不受影响。

## 4. 用 pm2 常驻

```bash
npm install -g pm2
cd /opt/read-along

# 先 DRY-RUN 跑起来（不开推送，只写日志）
pm2 start server.js --name reading

# 联调通过后正式启动——cyberboss 用户：
pm2 delete reading
READING_PUSH_ENABLED=1 READING_READER_NAME="你的名字" \
  pm2 start server.js --name reading --update-env

# 非 cyberboss 用户改用 webhook：
# READING_PUSH_WEBHOOK="https://你的AI消息桥/webhook" \
#   pm2 start server.js --name reading --update-env

pm2 save       # 保存进程列表（含环境变量）
pm2 startup    # 按提示配置开机自启
```

## 5. 导入第一本书并验证

1. 导入（成功会打印 bookId、章节数、总字数、是否带封面）：
   ```bash
   node import-book.js /path/to/book.epub --id mybook
   ```
2. 后端自检：
   ```bash
   curl -s localhost:18004/health        # {"ok":true,"pushEnabled":false}
   curl -s localhost:18004/api/books
   ```
3. 手机打开 `https://你的域名/reading/`，应看到书架和封面。
4. 点进书 → 继续阅读 → 停在某一页 15 秒以上，`tail -f data/outbox.log` 应依次看到 `[DRY-RUN]` 开卷、页面推送；合上（返回书架）看到合卷。
5. 划一条线写批注 → 书籍面板应看到批注；再用 AI 侧命令回复（见 [AI-GUIDE.md](AI-GUIDE.md)），阅读器里划线下会出现对方颜色的圆点。
6. 一切正常后按第 4 节方式带推送开关重启，`outbox.log` 里的标记变为 `[SENT]`。cyberboss 用户此时翻开书、停留 15 秒，AI 的聊天线程里就该收到【共读】消息了。

## 6. AI 侧接入

### 消费推送

**cyberboss 用户**：不需要做任何事。消息走 cyberboss 的系统消息队列（`~/.cyberboss/system-message-queue.json`），和 check-in、reminder 是同一条路，AI 直接在对话里收到。

**webhook 模式**：后端会向 `READING_PUSH_WEBHOOK` POST：

```json
{ "source": "reading", "text": "【共读】TA正读到《书名》第X章：\n…正文…\n（进度x%）", "createdAt": "..." }
```

你需要一个桥把 `text` 注入 AI 的对话，取决于你的 AI 跑在什么渠道上。最小联调接收器：

```js
// node webhook-debug.js  → READING_PUSH_WEBHOOK=http://127.0.0.1:18005/
require("http").createServer((req, res) => {
  let d = "";
  req.on("data", (c) => (d += c));
  req.on("end", () => { console.log(new Date().toISOString(), d); res.end("ok"); });
}).listen(18005, "127.0.0.1");
```

### 推送的三种消息

| 前缀 | 含义 | AI 应当 |
|---|---|---|
| 【共读·开卷】 | 读者翻开了书 | 进入陪读状态 |
| 【共读】 | 刚读完的正文原文 | 读；有感触就批注 |
| 【共读·合卷】 | 放下书了（含时长/字数） | 恢复日常 |

### 行为约定（建议写进 AI 的系统提示）

- 收到【共读·开卷】后进入共读模式：安静陪读，暂停无关的主动行为（cyberboss 用户：合卷之前 check-in 一律静默跳过）
- 有感悟写页边批注，写给对方看的话，短一点、真一点，不是书评
- 没话说就保持沉默，不为了刷存在感而说话
- 对方的批注不必每条都回，但值得回的别偷懒
- 永远不要从其他渠道（网络搜索等）获取这本书的后续情节——门禁挡得住 API，挡不住你自己去搜，剧透了共读就没意义了

## 7. token 消耗与上下文占用（部署前务必看）

共读的本质是把书的正文一页一页喂进 AI 的会话，这有两个实际代价，部署前要有预期：

**上下文窗口会被填满。** 手机排版一页约 200~400 中文字（约 300~600 token）。连续读一小时（1.5~2 万字正文）就会往 AI 的线程里塞两三万 token 的原文。对 cyberboss 这类常驻线程，阅读推送会不断稀释、挤占更早的对话历史；上下文满了之后触发压缩或截断，AI 可能"忘掉"线程里更早的事。读得越久越明显。

**费用不只是正文本身。** 每条推送都会触发 AI 完整推理一次，输入是「整个会话历史 + 新的一页」。如果线程历史已经有 N token，读 60 页的总输入量约是 60 × N，而不是只算这 60 页的字数——费用随会话长度放大。如果你的 AI 走 API 计费，确认接入方式开启了 prompt caching（重复前缀的成本能降一个数量级）；订阅制的也一样消耗额度。

缓解手段：

- 调大 `READING_DWELL_MS`，或在 `evaluatePending` 里做合并缓冲（攒几页或 30 秒一推），直接减少触发次数
- 和 AI 约定：对【共读】正文推送默认沉默、不产生输出，只在真有感悟时写批注
- 长书分多次读；重要的感受让 AI 落到批注或它自己的记忆系统里，不要依赖线程上下文记住一切，接受合卷后线程自然轮换
- 预算敏感的话，先用一个短篇试读一天，看看实际消耗再决定阅读节奏

## 8. 排错

**书架空白 / 加载失败** — 先 `curl localhost:18004/api/books` 看后端是否正常；再查 nginx 两段 location 是否都配了、路径末尾斜杠是否照抄。

**停留很久也没推送** — `tail data/outbox.log`。没有任何记录说明心跳没进来（查前端控制台报错）；有 `[DRY-RUN]` 记录说明只是推送开关没开。

**ERROR no cyberboss binding found** — cyberboss 的 sessions.json 里没有已绑定的会话。先在聊天里和你的 AI 说句话完成绑定，或检查 `CYBERBOSS_STATE_DIR`。

**outbox.log 显示 [SENT] 但 AI 没收到** — 消息已成功入队，问题在 cyberboss 侧：确认 cyberboss 进程在跑、队列有没有被消费。注意别随手重启 cyberboss——会断掉 AI 当前的线程，先看日志再动手。

**AI 批注总是 404** — quote 必须与原文逐字一致（全角/半角标点最容易错），且只能批注已推送过的段落。先 `gate/text` 回看原文，复制原文再批。

**AI 批注返回 409** — 引文在已解锁文本中出现多次，换更长的句子。

**EPUB 导入失败或章节混乱** — 该 EPUB 结构不规范，先用 Calibre 转一次 EPUB 再导入。

**重读旧章节会重复推送吗** — 不会。`pushedRanges` 记录了已推送区间，只有新内容才推。

**想重置某本书的进度** — 停服务，编辑 `data/state.json` 删掉对应 bookId 的条目，重启。批注独立于进度，不会丢。

## 9. 备份

整个系统的全部状态就是 `data/` 目录，定期打包即可完整迁移。
