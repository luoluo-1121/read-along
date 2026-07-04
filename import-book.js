#!/usr/bin/env node
// 用法: node import-book.js <epub路径> [--id 自定义bookId]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseEpub } = require("./lib/epub");
const { BOOKS_DIR, writeJson } = require("./lib/store");

function splitParagraphs(text) {
  return String(text)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith("--"));
  if (!inputPath) {
    console.error("usage: node import-book.js <epub> [--id xxx]");
    process.exit(1);
  }
  const idFlag = args.indexOf("--id");
  const parsed = parseEpub(inputPath);
  const title = parsed.metadata.title || path.basename(inputPath, ".epub");
  const author = parsed.metadata.author || "佚名";
  const bookId = idFlag >= 0 && args[idFlag + 1]
    ? args[idFlag + 1].replace(/[^a-zA-Z0-9_-]/g, "")
    : "b" + crypto.createHash("sha1").update(title).digest("hex").slice(0, 8);

  const dir = path.join(BOOKS_DIR, bookId);
  fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });

  let seq = 0;
  let totalChars = 0;
  const chapters = [];
  parsed.sections.forEach((section, idx) => {
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

  let coverExt = "";
  if (parsed.cover) {
    coverExt = parsed.cover.ext;
    fs.writeFileSync(path.join(dir, `cover${coverExt}`), parsed.cover.data);
  }

  const manifest = {
    bookId,
    title,
    author,
    importedAt: new Date().toISOString(),
    sourceFile: path.basename(inputPath),
    chapterCount: chapters.length,
    paraCount: seq,
    totalChars,
    coverExt,
    chapters,
  };
  writeJson(path.join(dir, "manifest.json"), manifest);

  console.log(JSON.stringify({ bookId, title, author, chapterCount: chapters.length, paraCount: seq, totalChars, cover: Boolean(coverExt) }, null, 2));
}

main();
