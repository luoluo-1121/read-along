// TXT 解析：编码检测（UTF-8 优先，失败回退 GBK）+ 章节切分
const { cleanText } = require("./epub");

function decode(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gbk").decode(buffer);
  }
}

// 标题行不含句读标点，避免把「第三章讲的是…」这类正文行误判成章节
const CHAPTER_RE = /^\s*(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节卷集部][^\n。，,.！!？?；;：:]{0,25}|(?:序章|序言|楔子|引子|尾声|后记|番外)[^\n。，,.！!？?；;：:]{0,20})\s*$/;

// 一行到底的病态文本：超长行按句子切开，避免出现上万字的"段落"
function splitLongLine(line, max = 600) {
  if (line.length <= max) return [line];
  const out = [];
  let buf = "";
  for (const piece of line.split(/(?<=[。！？!?])/)) {
    if (buf && buf.length + piece.length > max) {
      out.push(buf);
      buf = "";
    }
    buf += piece;
  }
  if (buf) out.push(buf);
  return out;
}

// 没识别出章节结构时，按约 4000 字一段硬切
function chunkBySize(paragraphs) {
  const sections = [];
  let buf = [];
  let chars = 0;
  const flush = () => {
    if (buf.length) sections.push({ title: `第${sections.length + 1}部分`, text: buf.join("\n") });
    buf = [];
    chars = 0;
  };
  for (const p of paragraphs) {
    buf.push(p);
    chars += p.length;
    if (chars >= 4000) flush();
  }
  flush();
  return sections;
}

function parseTxt(buffer, { fallbackTitle = "未命名" } = {}) {
  const text = cleanText(decode(buffer));
  if (!text) throw new Error("TXT 内容为空");
  const lines = text.split("\n").flatMap((line) => splitLongLine(line));

  const sections = [];
  let current = { title: "", lines: [] };
  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (!body && !current.title) return;
    // 章节标题并入正文首行，阅读器把首段渲染为章节题
    sections.push({ title: current.title || "开头", text: current.title ? `${current.title}\n${body}` : body });
  };
  for (const line of lines) {
    if (line.length <= 40 && CHAPTER_RE.test(line)) {
      flush();
      current = { title: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const recognized = sections.filter((s) => s.title !== "开头");
  const finalSections = recognized.length >= 2
    ? sections
    : chunkBySize(lines.map((l) => l.trim()).filter(Boolean));
  if (!finalSections.length) throw new Error("TXT parsed to zero sections");

  return { metadata: { title: fallbackTitle, author: "" }, sections: finalSections, cover: null };
}

module.exports = { parseTxt };
