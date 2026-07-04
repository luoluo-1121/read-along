const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUTBOX_LOG = path.join(__dirname, "..", "data", "outbox.log");

// 推送通道按优先级三选一：
// 1. 设了 READING_PUSH_WEBHOOK   → POST 到该地址
// 2. 设了 READING_PUSH_ENABLED=1 → 写 cyberboss 系统消息队列
// 3. 都没设                       → DRY-RUN，只写日志不外发
const WEBHOOK = process.env.READING_PUSH_WEBHOOK || "";
const CYBERBOSS_STATE_DIR = process.env.CYBERBOSS_STATE_DIR || path.join(process.env.HOME || "/root", ".cyberboss");
const QUEUE_FILE = path.join(CYBERBOSS_STATE_DIR, "system-message-queue.json");
const SESSIONS_FILE = path.join(CYBERBOSS_STATE_DIR, "sessions.json");
const PUSH_ENABLED = Boolean(WEBHOOK) || process.env.READING_PUSH_ENABLED === "1";

function logOutbox(status, text) {
  const line = `${new Date().toISOString()} [${status}] ${text.replace(/\n/g, "\\n").slice(0, 400)}\n`;
  try {
    fs.appendFileSync(OUTBOX_LOG, line);
  } catch {}
}

// cyberboss：从 sessions.json 找到已绑定的会话（推送目标）
function resolveTarget() {
  const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  const bindings = Object.values(sessions?.bindings || {});
  const binding = bindings.find((b) => b?.accountId && b?.senderId);
  if (!binding) throw new Error("no cyberboss binding found in sessions.json");
  return {
    accountId: binding.accountId,
    senderId: binding.senderId,
    workspaceRoot: binding.activeWorkspaceRoot || process.env.HOME || "/root",
  };
}

// cyberboss：把消息原子追加进系统消息队列
function pushCyberboss(text) {
  const target = resolveTarget();
  const message = {
    id: crypto.randomUUID(),
    accountId: target.accountId,
    senderId: target.senderId,
    workspaceRoot: target.workspaceRoot,
    text,
    createdAt: new Date().toISOString(),
  };

  const state = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
      return { messages: Array.isArray(parsed?.messages) ? parsed.messages : [] };
    } catch {
      return { messages: [] };
    }
  })();
  state.messages.push(message);

  const tmp = `${QUEUE_FILE}.reading-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, QUEUE_FILE);

  logOutbox("SENT", text);
  return { ok: true, id: message.id };
}

// webhook：POST 出去，结果异步记日志
function pushWebhook(text) {
  fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "reading", text, createdAt: new Date().toISOString() }),
  })
    .then((r) => logOutbox(r.ok ? "SENT" : `HTTP-${r.status}`, text))
    .catch((error) => logOutbox("ERROR " + (error?.message || error), text));
  return { ok: true };
}

function enqueueSystemMessage(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  if (!PUSH_ENABLED) {
    logOutbox("DRY-RUN", trimmed);
    return { ok: true, dryRun: true };
  }

  try {
    if (WEBHOOK) return pushWebhook(trimmed);
    return pushCyberboss(trimmed);
  } catch (error) {
    logOutbox("ERROR " + (error?.message || error), trimmed);
    return { ok: false, reason: String(error?.message || error) };
  }
}

module.exports = { enqueueSystemMessage, PUSH_ENABLED };
