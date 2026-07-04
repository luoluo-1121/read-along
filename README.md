# read-along 共读

**让你的 AI 陪你一页一页把书读完。**

你在手机上看书，你的 AI 实时"跟着你读"，你们可以在同一本书的页边划线、写批注、互相回复——像和一个真人共用一本书，在页边传纸条。

市面上的"AI 读书"大多是反过来的：AI 先把整本书吞了，然后给你讲书、划重点、写摘要。这个系统不做那件事。它做的是**陪读**——AI 和你保持同样的进度，你读到哪，它才知道到哪，你们聊的永远是"刚刚读到的那一段"。

## 核心设计：防剧透门禁

- 你在某一页**停留超过 15 秒**，这一页的原文才会推送给 AI。快速翻过去的不算数。
- AI **无法读取你还没读到的任何内容**。不是"说好了不看"，而是系统层面就拿不到——连未读章节的标题都对它保密。
- AI 回看、搜索、写批注，范围永远只限你已经读过的部分。它写批注必须逐字引用一句你读过的原文，想"预埋"后文的批注做不到。

所以 AI 的处境和一个真正的共读伙伴一模一样：和你在同一页，对后面的情节一样一无所知。它的好奇、猜测和惊讶，都是真的。

## 功能

- **网页阅读器**（单文件、零依赖）：书架、分页阅读、进度记忆、两点点选划线批注、批注对话与跳回原文
- **EPUB 导入**：一条命令把书导入书库，自动抽章节、封面
- **阅读事件推送**：开卷 / 每页原文 / 合卷（含本次时长与字数），推给你的 AI
- **批注互动**：双方划线用不同颜色区分，每条划线下可以盖楼回复
- **推送通道**：内置 cyberboss 系统消息队列支持；非 cyberboss 用户可用通用 webhook 模式

## 快速开始

```bash
git clone <this-repo> && cd read-along
npm install

# 先跑起来（DRY-RUN 模式：推送只写日志，不外发）
node server.js

# 导入一本书
node import-book.js /path/to/book.epub --id mybook
```

前端：把 `web/reader.html` 放到 nginx 下，API 反代到 `127.0.0.1:18004`（详见 [docs/DEPLOY.md](docs/DEPLOY.md)）。

联调通过后，开启真实推送：

```bash
# cyberboss 用户
READING_PUSH_ENABLED=1 READING_READER_NAME=你的名字 node server.js

# 其他用户：给一个能收 HTTP POST 的 webhook
READING_PUSH_WEBHOOK=https://your-bridge/webhook node server.js
```

完整的部署步骤（nginx、HTTPS、pm2 常驻、AI 侧接入、排错）见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。AI 侧的批注操作指南见 **[docs/AI-GUIDE.md](docs/AI-GUIDE.md)**。

## 架构

```
手机浏览器（web/reader.html）
    │ HTTPS · 翻页心跳每10秒
    ↓
nginx（反向代理）
    ↓
共读后端 Node 服务（127.0.0.1:18004）
书库 API · 心跳/停留判定 · 批注存储 · 门禁读取
    │ 推送
    ↓
cyberboss 系统消息队列 / 你的 webhook
    ↓
你的 AI 的聊天线程
```

数据全部是本地 JSON 文件（`data/` 目录），无数据库，写入原子替换。备份 = 打包 `data/`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `READING_PORT` | `18004` | 监听端口（仅绑 127.0.0.1） |
| `READING_DWELL_MS` | `15000` | 一页停留多少毫秒算"读过" |
| `READING_IDLE_MS` | `300000` | 心跳断多久自动判定合卷 |
| `READING_PUSH_ENABLED` | 空 | `=1` 时写 cyberboss 系统消息队列 |
| `CYBERBOSS_STATE_DIR` | `~/.cyberboss` | cyberboss 状态目录 |
| `READING_PUSH_WEBHOOK` | 空 | 设了则改走 webhook（优先于 cyberboss） |
| `READING_READER_NAME` | `TA` | 推送文案里对读者的称呼 |

两个推送开关都不设 = DRY-RUN，只记 `data/outbox.log` 不外发。

## 注意

- 本方案没有内置登录。书和批注是私人内容，建议加一层 nginx Basic Auth 或使用不可猜测的路径。
- 请只导入你有权阅读的书籍文件，不要把书籍数据（`data/`）提交进任何公开仓库。
- **推送会把书的正文持续喂进 AI 的会话**：上下文占用和 token 费用都随阅读量增长（每条推送触发一次带全部历史的推理）。部署前请读 [docs/DEPLOY.md](docs/DEPLOY.md) 的「token 消耗与上下文占用」一节。

## 致谢

本项目的设计参考了两个很棒的项目：

- [cyberboss](https://github.com/WenXiaoWendy/cyberboss) — 微信接入的本地 agent 桥，让 AI 主动陪伴、感知时间地在场。read-along 的推送通道直接构建在它的系统消息队列之上，「AI 常驻于你日常的聊天窗口」这个前提也来自它。
- [co-reading-kit](https://github.com/Youxuuuuu/co-reading-kit) — 低 token 成本的人机协作阅读 MCP 工具箱。本地书库、分块加载、无数据库的轻量思路给了我们很多启发。

## License

MIT
