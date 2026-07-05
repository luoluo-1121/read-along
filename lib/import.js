// 导入核心：解析结果 → 书库文件（import-book.js 命令行与 /api/import 共用）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BOOKS_DIR, writeJson, readManifest } = require("./store");

function splitParagraphs(text) {
  return String(text)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function importParsed(parsed, { bookId, sourceFile = "", allowOverwrite = true } = {}) {
  const title = parsed.metadata.title || path.basename(sourceFile).replace(/\.[^.]+$/, "") || "未命名";
  const author = parsed.metadata.author || "佚名";
  const id = String(bookId || "b" + crypto.createHash("sha1").update(title).digest("hex").slice(0, 8))
    .replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) throw new Error("bad bookId");
  if (!allowOverwrite && readManifest(id)) {
    throw Object.assign(new Error(`书已存在（bookId: ${id}）`), { status: 409 });
  }

  const dir = path.join(BOOKS_DIR, id);
  fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });

  let seq = 0;
  let totalChars = 0;
  const chapters = [];
  parsed.sections.forEach((section) => {
    const paragraphs = splitParagraphs(section.text);
    if (!paragraphs.length) return;
    const chars = paragraphs.reduce((sum, p) => sum + p.length, 0);
    const chapter = {
      idx: chapters.length,
      title: section.title,
      baseSeq: seq,
      paraCount: paragraphs.length,
      chars,
      paragraphs,
    };
    writeJson(path.join(dir, "chapters", `${chapter.idx}.json`), chapter);
    chapters.push({ idx: chapter.idx, title: chapter.title, baseSeq: chapter.baseSeq, paraCount: chapter.paraCount, chars });
    seq += paragraphs.length;
    totalChars += chars;
  });
  if (!chapters.length) throw new Error("解析结果没有任何正文章节");

  let coverExt = "";
  if (parsed.cover) {
    coverExt = parsed.cover.ext;
    fs.writeFileSync(path.join(dir, `cover${coverExt}`), parsed.cover.data);
  }

  const manifest = {
    bookId: id,
    title,
    author,
    importedAt: new Date().toISOString(),
    sourceFile: path.basename(sourceFile),
    chapterCount: chapters.length,
    paraCount: seq,
    totalChars,
    coverExt,
    chapters,
  };
  writeJson(path.join(dir, "manifest.json"), manifest);

  return { bookId: id, title, author, chapterCount: chapters.length, paraCount: seq, totalChars, cover: Boolean(coverExt) };
}

module.exports = { importParsed };
