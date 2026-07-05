#!/usr/bin/env node
// 共读后端：书库 API + 阅读心跳/停留判定 + 批注存储 + AI 推送桥
const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./lib/store");
const { enqueueSystemMessage, PUSH_ENABLED } = require("./lib/push");
const { parseEpub } = require("./lib/epub");
const { parseTxt } = require("./lib/txt");
const { importParsed } = require("./lib/import");

const PORT = Number(process.env.READING_PORT || 18004);
const DWELL_MS = Number(process.env.READING_DWELL_MS || 15000);
const IDLE_CLOSE_MS = Number(process.env.READING_IDLE_MS || 5 * 60 * 1000);
const READER_NAME = process.env.READING_READER_NAME || "TA";

// ── 推送文案 ──

function pct(bs, manifest) {
  if (!manifest.paraCount) return 0;
  return Math.min(100, Math.round(((bs.furthestSeq + 1) / manifest.paraCount) * 1000) / 10);
}

function fmtDur(ms) {
  const minutes = Math.round((ms || 0) / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function chapterOfSeq(manifest, seq) {
  let found = manifest.chapters[0];
  for (const ch of manifest.chapters) {
    if (ch.baseSeq <= seq) found = ch;
    else break;
  }
  return found;
}

function pushOpen(bs, manifest) {
  const ch = bs.lastPos ? manifest.chapters[bs.lastPos.chapter] : manifest.chapters[0];
  enqueueSystemMessage(
    `【共读·开卷】${READER_NAME}翻开了《${manifest.title}》（${ch ? ch.title : "开头"} · 进度${pct(bs, manifest)}%）。\n` +
    `共读模式开启：合上书之前请安静陪读。读过的每一页会随阅读推送过来；` +
    `有感悟就写页边批注（POST /api/annotate），没话说就保持沉默。`
  );
}

function pushClose(bs, manifest, { auto = false, sessionMs = 0 } = {}) {
  const minutes = Math.max(1, Math.round(sessionMs / 60000));
  const chars = bs.session ? bs.session.pushedChars : 0;
  const ch = bs.lastPos ? manifest.chapters[bs.lastPos.chapter] : null;
  enqueueSystemMessage(
    `【共读·合卷】${READER_NAME}${auto ? "有一会儿没翻页了，应该是放下了" : "合上了"}《${manifest.title}》。` +
    `这次读了约${minutes}分钟、${chars}字，停在${ch ? ch.title : "开头"}（进度${pct(bs, manifest)}%，本书累计共读${fmtDur(bs.totalReadMs)}）。共读模式结束。`
  );
}

function pushPage(manifest, chapterIdx, texts, bs) {
  const ch = manifest.chapters[chapterIdx];
  enqueueSystemMessage(
    `【共读】${READER_NAME}正读到《${manifest.title}》${ch ? ch.title : ""}：\n${texts.join("\n\n")}\n（进度${pct(bs, manifest)}%）`
  );
}

// ── 停留判定 ──

function evaluatePending(state, bookId) {
  const bs = store.bookState(state, bookId);
  const session = bs.session;
  if (!session || !session.pending) return;
  const pending = session.pending;
  if (Date.now() - pending.since < DWELL_MS) return;

  const manifest = store.readManifest(bookId);
  if (!manifest) return;
  const missing = store.missingSeqs(bs.pushedRanges, pending.seqStart, pending.seqEnd);
  if (!missing.length) return;

  const chapter = store.readChapter(bookId, pending.chapter);
  if (!chapter) return;
  const texts = [];
  let chars = 0;
  for (const seq of missing) {
    const para = chapter.paragraphs[seq - chapter.baseSeq];
    if (typeof para === "string") {
      texts.push(para);
      chars += para.length;
    }
  }
  if (!texts.length) return;

  pushPage(manifest, pending.chapter, texts, bs);
  bs.pushedRanges = store.mergeRange(bs.pushedRanges, missing[0], missing[missing.length - 1]);
  bs.furthestSeq = Math.max(bs.furthestSeq, pending.seqEnd);
  bs.totalPushedChars += chars;
  session.pushedChars += chars;
}

// ── 心跳 ──

function handleBeat(body) {
  const { bookId, event } = body || {};
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };

  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const now = Date.now();

  const ensureSession = () => {
    if (bs.session) return;
    bs.session = { openedAt: now, lastBeatAt: now, pending: null, pushedChars: 0 };
    bs.lastOpenedAt = new Date().toISOString();
    // 合卷后2分钟内重开（跳转/查目录的往返）不重复报开卷
    if (!bs.lastClosedAt || now - bs.lastClosedAt > 120000) pushOpen(bs, manifest);
  };

  if (event === "open") {
    if (!bs.session) ensureSession();
    else bs.session.lastBeatAt = now;
  } else if (event === "page" || event === "beat") {
    ensureSession();
    evaluatePending(state, bookId);
    bs.session.lastBeatAt = now;
    const chapter = Number(body.chapter);
    const seqStart = Number(body.seqStart);
    const seqEnd = Number(body.seqEnd);
    if (Number.isInteger(chapter) && Number.isInteger(seqStart) && Number.isInteger(seqEnd) && seqEnd >= seqStart) {
      bs.lastPos = { chapter, seqTop: seqStart, pageKey: String(body.pageKey || "") };
      if (event === "page" || !bs.session.pending || bs.session.pending.pageKey !== String(body.pageKey || "")) {
        bs.session.pending = { pageKey: String(body.pageKey || ""), since: now, chapter, seqStart, seqEnd };
      }
    }
  } else if (event === "close") {
    if (bs.session) {
      evaluatePending(state, bookId);
      const sessionMs = Math.max(0, now - bs.session.openedAt);
      bs.totalReadMs = (bs.totalReadMs || 0) + sessionMs;
      // 没读出内容且不到1分钟的会话（误点、纯跳转）静默关闭
      if (bs.session.pushedChars > 0 || sessionMs >= 60000) {
        pushClose(bs, manifest, { auto: false, sessionMs });
      }
      bs.lastClosedAt = now;
      bs.session = null;
    }
  } else {
    return { status: 400, json: { error: "bad event" } };
  }

  store.writeState(state);
  return {
    status: 200,
    json: { ok: true, furthestSeq: bs.furthestSeq, progressPct: pct(bs, manifest), pushEnabled: PUSH_ENABLED },
  };
}

// 空闲扫描：心跳断了视为放下书
setInterval(() => {
  try {
    const state = store.readState();
    let dirty = false;
    for (const bookId of Object.keys(state.books)) {
      const bs = state.books[bookId];
      if (bs.session && Date.now() - bs.session.lastBeatAt > IDLE_CLOSE_MS) {
        const manifest = store.readManifest(bookId);
        evaluatePending(state, bookId);
        // 掐掉断连后的空转时间，只算到最后一次心跳
        const sessionMs = Math.max(0, bs.session.lastBeatAt - bs.session.openedAt);
        bs.totalReadMs = (bs.totalReadMs || 0) + sessionMs;
        if (manifest) pushClose(bs, manifest, { auto: true, sessionMs });
        bs.session = null;
        dirty = true;
      }
    }
    if (dirty) store.writeState(state);
  } catch (error) {
    console.error("[reading] idle sweep error", error);
  }
}, 60 * 1000);

// ── 批注 ──

function createAnnotation(body, { gate = false } = {}) {
  const { bookId, author, comment } = body || {};
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  if (!comment || !String(comment).trim()) return { status: 400, json: { error: "comment required" } };
  if (!["human", "ai"].includes(author)) return { status: 400, json: { error: "author must be human|ai" } };

  let seq;
  let startOff;
  let endOff;
  let quote = String(body.quote || "").trim();

  if (gate) {
    // AI 侧：给原文，服务端在已解锁范围内精确定位
    if (!quote) return { status: 400, json: { error: "quote required" } };
    const state = store.readState();
    const bs = store.bookState(state, bookId);
    const matches = [];
    for (const [rs, re] of bs.pushedRanges) {
      for (let s = rs; s <= re; s += 1) {
        const ch = chapterOfSeq(manifest, s);
        const chapter = store.readChapter(bookId, ch.idx);
        const para = chapter.paragraphs[s - ch.baseSeq];
        if (typeof para !== "string") continue;
        const at = para.indexOf(quote);
        if (at >= 0) matches.push({ seq: s, startOff: at, endOff: at + quote.length, preview: para.slice(0, 40) });
      }
    }
    if (!matches.length) return { status: 404, json: { error: "quote not found in unlocked text（只能批注已解锁的内容，且必须与原文逐字一致）" } };
    if (matches.length > 1) return { status: 409, json: { error: "quote ambiguous, give a longer quote", matches: matches.slice(0, 5) } };
    ({ seq, startOff, endOff } = matches[0]);
  } else {
    // 人类侧：前端给精确锚点
    const chapterIdx = Number(body.chapter);
    const paraIdx = Number(body.paraIdx);
    const chapter = store.readChapter(bookId, chapterIdx);
    if (!chapter || typeof chapter.paragraphs[paraIdx] !== "string") {
      return { status: 400, json: { error: "bad anchor" } };
    }
    const para = chapter.paragraphs[paraIdx];
    startOff = Math.max(0, Number(body.startOff) || 0);
    endOff = Math.min(para.length, Number(body.endOff) || 0);
    if (endOff <= startOff) return { status: 400, json: { error: "bad offsets" } };
    seq = chapter.baseSeq + paraIdx;
    quote = para.slice(startOff, endOff);
  }

  const annotations = store.readAnnotations(bookId);
  const now = new Date().toISOString();
  const annotation = {
    id: store.newId(),
    seq,
    startOff,
    endOff,
    quote,
    createdBy: author,
    createdAt: now,
    comments: [{ id: store.newId(), author, text: String(comment).trim(), createdAt: now }],
  };
  annotations.push(annotation);
  store.writeAnnotations(bookId, annotations);
  return { status: 200, json: { ok: true, annotation } };
}

function addComment(bookId, annoId, body) {
  const { author, text } = body || {};
  if (!["human", "ai"].includes(author)) return { status: 400, json: { error: "author must be human|ai" } };
  if (!text || !String(text).trim()) return { status: 400, json: { error: "text required" } };
  const annotations = store.readAnnotations(bookId);
  const annotation = annotations.find((a) => a.id === annoId);
  if (!annotation) return { status: 404, json: { error: "unknown annotation" } };
  const comment = { id: store.newId(), author, text: String(text).trim(), createdAt: new Date().toISOString() };
  annotation.comments.push(comment);
  store.writeAnnotations(bookId, annotations);
  return { status: 200, json: { ok: true, comment } };
}

// ── 书签（读者私有：不推送，也不进 AI 侧 gate） ──

function createBookmark(body) {
  const { bookId } = body || {};
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const seq = Number(body.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq >= manifest.paraCount) {
    return { status: 400, json: { error: "bad seq" } };
  }
  const bookmarks = store.readBookmarks(bookId);
  if (bookmarks.some((m) => m.seq === seq)) return { status: 409, json: { error: "bookmark exists" } };
  const ch = chapterOfSeq(manifest, seq);
  const chapter = store.readChapter(bookId, ch.idx);
  const para = chapter ? chapter.paragraphs[seq - ch.baseSeq] : "";
  const bookmark = {
    id: store.newId(),
    seq,
    chapter: ch.idx,
    chapterTitle: ch.title,
    excerpt: String(para || "").slice(0, 40),
    createdAt: new Date().toISOString(),
  };
  bookmarks.push(bookmark);
  bookmarks.sort((a, b) => a.seq - b.seq);
  store.writeBookmarks(bookId, bookmarks);
  return { status: 200, json: { ok: true, bookmark } };
}

function deleteBookmark(bookId, markId) {
  const bookmarks = store.readBookmarks(bookId);
  const next = bookmarks.filter((m) => m.id !== markId);
  if (next.length === bookmarks.length) return { status: 404, json: { error: "unknown bookmark" } };
  store.writeBookmarks(bookId, next);
  return { status: 200, json: { ok: true } };
}

// ── 门禁读取（AI 侧） ──

function gateInfo(bookId) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const unlockedChapters = manifest.chapters
    .filter((ch) => ch.baseSeq <= bs.furthestSeq)
    .map((ch) => ({ idx: ch.idx, title: ch.title, baseSeq: ch.baseSeq, paraCount: ch.paraCount }));
  return {
    status: 200,
    json: {
      bookId,
      title: manifest.title,
      author: manifest.author,
      furthestSeq: bs.furthestSeq,
      pushedRanges: bs.pushedRanges,
      progressPct: pct(bs, manifest),
      reading: Boolean(bs.session),
      lastOpenedAt: bs.lastOpenedAt,
      unlockedChapters,
      note: "unlockedChapters 之外的章节标题也是保密的",
    },
  };
}

function gateText(bookId, from, to) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 200) {
    return { status: 400, json: { error: "bad range (max 200 paras)" } };
  }
  const paragraphs = [];
  const locked = [];
  for (let seq = start; seq <= end; seq += 1) {
    if (!store.inRanges(bs.pushedRanges, seq)) {
      locked.push(seq);
      continue;
    }
    const ch = chapterOfSeq(manifest, seq);
    const chapter = store.readChapter(bookId, ch.idx);
    const para = chapter.paragraphs[seq - ch.baseSeq];
    if (typeof para === "string") paragraphs.push({ seq, chapter: ch.idx, chapterTitle: ch.title, text: para });
  }
  return { status: 200, json: { paragraphs, locked: locked.length ? `${locked.length}段未解锁` : undefined } };
}

function gateSearch(bookId, q) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const query = String(q || "").trim();
  if (!query) return { status: 400, json: { error: "q required" } };
  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const hits = [];
  for (const [rs, re] of bs.pushedRanges) {
    for (let seq = rs; seq <= re && hits.length < 20; seq += 1) {
      const ch = chapterOfSeq(manifest, seq);
      const chapter = store.readChapter(bookId, ch.idx);
      const para = chapter.paragraphs[seq - ch.baseSeq];
      if (typeof para === "string" && para.includes(query)) {
        hits.push({ seq, chapter: ch.idx, chapterTitle: ch.title, text: para });
      }
    }
  }
  return { status: 200, json: { hits, scope: "仅已解锁范围" } };
}

// ── HTTP 路由 ──

function send(res, status, json) {
  const body = JSON.stringify(json);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("文件太大（上限50MB）"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  let m;

  try {
    if (req.method === "GET" && p === "/api/books") {
      const state = store.readState();
      const books = store.listBookIds().map((bookId) => {
        const manifest = store.readManifest(bookId);
        const bs = store.bookState(state, bookId);
        return {
          bookId,
          title: manifest.title,
          author: manifest.author,
          chapterCount: manifest.chapterCount,
          totalChars: manifest.totalChars,
          progressPct: pct(bs, manifest),
          lastOpenedAt: bs.lastOpenedAt,
          lastPos: bs.lastPos,
          totalReadMs: bs.totalReadMs || 0,
          hasCover: Boolean(manifest.coverExt),
          annotationCount: store.readAnnotations(bookId).length,
        };
      });
      return send(res, 200, { books });
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/book\/([\w-]+)$/))) {
      const manifest = store.readManifest(m[1]);
      if (!manifest) return send(res, 404, { error: "unknown book" });
      const state = store.readState();
      const bs = store.bookState(state, m[1]);
      return send(res, 200, { manifest, progressPct: pct(bs, manifest), lastPos: bs.lastPos, lastOpenedAt: bs.lastOpenedAt, totalReadMs: bs.totalReadMs || 0 });
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/book\/([\w-]+)\/chapter\/(\d+)$/))) {
      const chapter = store.readChapter(m[1], m[2]);
      if (!chapter) return send(res, 404, { error: "unknown chapter" });
      return send(res, 200, chapter);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/cover\/([\w-]+)$/))) {
      const manifest = store.readManifest(m[1]);
      if (!manifest || !manifest.coverExt) return send(res, 404, { error: "no cover" });
      const file = path.join(store.bookDir(m[1]), `cover${manifest.coverExt}`);
      const type = manifest.coverExt === ".png" ? "image/png" : "image/jpeg";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === "POST" && p === "/api/import") {
      // 前端上传：文件二进制作请求体，文件名走查询参数（免 multipart）
      try {
        const filename = decodeURIComponent(url.searchParams.get("filename") || "");
        const ext = path.extname(filename).toLowerCase();
        if (![".epub", ".txt"].includes(ext)) return send(res, 400, { error: "只支持 .epub 和 .txt" });
        const buffer = await readRawBody(req, IMPORT_MAX_BYTES);
        if (!buffer.length) return send(res, 400, { error: "empty file" });
        const parsed = ext === ".epub"
          ? parseEpub(buffer)
          : parseTxt(buffer, { fallbackTitle: path.basename(filename, ext) });
        const book = importParsed(parsed, {
          bookId: url.searchParams.get("id") || undefined,
          sourceFile: filename,
          allowOverwrite: false,
        });
        return send(res, 200, { ok: true, book });
      } catch (error) {
        return send(res, error.status || 400, { error: String(error?.message || error) });
      }
    }

    if (req.method === "POST" && p === "/api/beat") {
      const out = handleBeat(await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/annotations\/([\w-]+)$/))) {
      return send(res, 200, { annotations: store.readAnnotations(m[1]) });
    }

    if (req.method === "POST" && p === "/api/annotations") {
      const out = createAnnotation(await readBody(req), { gate: false });
      return send(res, out.status, out.json);
    }

    if (req.method === "POST" && p === "/api/annotate") {
      const body = await readBody(req);
      body.author = "ai";
      const out = createAnnotation(body, { gate: true });
      return send(res, out.status, out.json);
    }

    if (req.method === "POST" && (m = p.match(/^\/api\/annotations\/([\w-]+)\/([\w-]+)\/comment$/))) {
      const out = addComment(m[1], m[2], await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/bookmarks\/([\w-]+)$/))) {
      return send(res, 200, { bookmarks: store.readBookmarks(m[1]) });
    }

    if (req.method === "POST" && p === "/api/bookmarks") {
      const out = createBookmark(await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "DELETE" && (m = p.match(/^\/api\/bookmarks\/([\w-]+)\/([\w-]+)$/))) {
      const out = deleteBookmark(m[1], m[2]);
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/gate\/([\w-]+)$/))) {
      const out = gateInfo(m[1]);
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/gate\/([\w-]+)\/text$/))) {
      const out = gateText(m[1], url.searchParams.get("from"), url.searchParams.get("to"));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/gate\/([\w-]+)\/search$/))) {
      const out = gateSearch(m[1], url.searchParams.get("q"));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && p === "/health") {
      return send(res, 200, { ok: true, pushEnabled: PUSH_ENABLED });
    }

    return send(res, 404, { error: "not found" });
  } catch (error) {
    return send(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[reading] listening on 127.0.0.1:${PORT} pushEnabled=${PUSH_ENABLED} dwell=${DWELL_MS}ms idle=${IDLE_CLOSE_MS}ms`);
});
