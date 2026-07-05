#!/usr/bin/env node
// 用法: node import-book.js <epub或txt路径> [--id 自定义bookId]
const fs = require("fs");
const path = require("path");
const { parseEpub } = require("./lib/epub");
const { parseTxt } = require("./lib/txt");
const { importParsed } = require("./lib/import");

function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith("--"));
  if (!inputPath) {
    console.error("usage: node import-book.js <epub|txt> [--id xxx]");
    process.exit(1);
  }
  const idFlag = args.indexOf("--id");
  const bookId = idFlag >= 0 && args[idFlag + 1] ? args[idFlag + 1] : undefined;

  const ext = path.extname(inputPath).toLowerCase();
  let parsed;
  if (ext === ".txt") {
    parsed = parseTxt(fs.readFileSync(inputPath), { fallbackTitle: path.basename(inputPath, ext) });
  } else {
    parsed = parseEpub(inputPath);
  }

  const summary = importParsed(parsed, { bookId, sourceFile: path.basename(inputPath) });
  console.log(JSON.stringify(summary, null, 2));
}

main();
