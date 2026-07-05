const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const ANNO_DIR = path.join(DATA_DIR, "annotations");
const STATE_FILE = path.join(DATA_DIR, "state.json");

for (const dir of [DATA_DIR, BOOKS_DIR, ANNO_DIR]) fs.mkdirSync(dir, { recursive: true });

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── books ──

function listBookIds() {
  try {
    return fs.readdirSync(BOOKS_DIR).filter((name) => fs.existsSync(path.join(BOOKS_DIR, name, "manifest.json")));
  } catch {
    return [];
  }
}

function bookDir(bookId) {
  const safe = String(bookId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("bad bookId");
  return path.join(BOOKS_DIR, safe);
}

function readManifest(bookId) {
  return readJson(path.join(bookDir(bookId), "manifest.json"), null);
}

function readChapter(bookId, idx) {
  return readJson(path.join(bookDir(bookId), "chapters", `${Number(idx)}.json`), null);
}

// ── state (progress / sessions) ──

function readState() {
  return readJson(STATE_FILE, { books: {} });
}

function writeState(state) {
  writeJson(STATE_FILE, state);
}

function bookState(state, bookId) {
  if (!state.books[bookId]) {
    state.books[bookId] = {
      furthestSeq: -1,
      pushedRanges: [],
      lastPos: null,
      lastOpenedAt: "",
      totalPushedChars: 0,
      totalReadMs: 0,
      session: null,
    };
  }
  return state.books[bookId];
}

function mergeRange(ranges, start, end) {
  const merged = [];
  let [s, e] = [start, end];
  for (const [rs, re] of ranges) {
    if (re < s - 1 || rs > e + 1) {
      merged.push([rs, re]);
    } else {
      s = Math.min(s, rs);
      e = Math.max(e, re);
    }
  }
  merged.push([s, e]);
  merged.sort((a, b) => a[0] - b[0]);
  return merged;
}

function inRanges(ranges, seq) {
  return ranges.some(([s, e]) => seq >= s && seq <= e);
}

function missingSeqs(ranges, start, end) {
  const missing = [];
  for (let seq = start; seq <= end; seq += 1) {
    if (!inRanges(ranges, seq)) missing.push(seq);
  }
  return missing;
}

// ── annotations ──

function annoFile(bookId) {
  return path.join(ANNO_DIR, `${String(bookId).replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

function readAnnotations(bookId) {
  return readJson(annoFile(bookId), []);
}

function writeAnnotations(bookId, annotations) {
  writeJson(annoFile(bookId), annotations);
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

module.exports = {
  DATA_DIR,
  BOOKS_DIR,
  readJson,
  writeJson,
  listBookIds,
  bookDir,
  readManifest,
  readChapter,
  readState,
  writeState,
  bookState,
  mergeRange,
  inRanges,
  missingSeqs,
  readAnnotations,
  writeAnnotations,
  newId,
};
