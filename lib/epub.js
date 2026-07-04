const path = require("path");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const { htmlToText } = require("html-to-text");

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function readXmlText(value) {
  if (Array.isArray(value)) return readXmlText(value[0]);
  if (value && typeof value === "object") return String(value["#text"] || "").trim();
  return String(value || "").trim();
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t　]+\n/g, "\n")
    .replace(/\n[ \t　]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHtmlHeading(html) {
  const m = String(html).match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
  if (!m) return "";
  return cleanText(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function fileStem(href) {
  return path.posix.basename(String(href).replace(/\\/g, "/")).replace(/\.[^.]+$/, "");
}

function readZipText(zip, entryPath) {
  const normalized = String(entryPath).replace(/\\/g, "/");
  const entry = zip.getEntry(normalized) || zip.getEntry(decodeURIComponent(normalized));
  return entry ? entry.getData().toString("utf8") : "";
}

function resolveZipPath(opfDir, href) {
  const clean = decodeURIComponent(String(href).replace(/\\/g, "/"));
  return opfDir === "." ? clean : path.posix.normalize(`${opfDir}/${clean}`);
}

function isHtmlItem(item) {
  const mediaType = String(item["media-type"] || "").toLowerCase();
  const href = String(item.href || "").toLowerCase();
  return mediaType.includes("html") || /\.x?html?$/.test(href);
}

function isSkippableName(name) {
  return /(^|[_\-./])(cover|toc|nav|copyright|titlepage|title-page|colophon|imprint)([_\-./]|$)/i.test(String(name || "").toLowerCase());
}

function findCover(zip, pkg, manifestItems, opfDir) {
  let coverId = "";
  for (const meta of asArray(pkg?.metadata?.meta)) {
    if (String(meta?.name || "").toLowerCase() === "cover") coverId = String(meta.content || "");
  }
  let item = manifestItems.find((it) => /\bcover-image\b/i.test(String(it.properties || "")))
    || (coverId && manifestItems.find((it) => String(it.id) === coverId))
    || manifestItems.find((it) => /^image\//i.test(String(it["media-type"] || "")) && /cover/i.test(String(it.href || "")));
  if (!item) {
    item = manifestItems.find((it) => /^image\//i.test(String(it["media-type"] || "")));
  }
  if (!item) return null;
  const entryPath = resolveZipPath(opfDir, item.href);
  const entry = zip.getEntry(entryPath);
  if (!entry) return null;
  const ext = path.posix.extname(entryPath).toLowerCase() || ".jpg";
  return { data: entry.getData(), ext, mediaType: String(item["media-type"] || "image/jpeg") };
}

function parseEpub(inputPath) {
  const zip = new AdmZip(inputPath);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", trimValues: true });

  const containerXml = readZipText(zip, "META-INF/container.xml");
  if (!containerXml) throw new Error("EPUB missing META-INF/container.xml");
  const container = parser.parse(containerXml);
  const opfPath = asArray(container?.container?.rootfiles?.rootfile)[0]?.["full-path"];
  if (!opfPath) throw new Error("container.xml has no OPF path");

  const opfXml = readZipText(zip, opfPath);
  if (!opfXml) throw new Error(`EPUB missing OPF: ${opfPath}`);
  const pkg = parser.parse(opfXml)?.package;
  const manifestItems = asArray(pkg?.manifest?.item);
  const spineItems = asArray(pkg?.spine?.itemref);
  if (!spineItems.length) throw new Error("EPUB spine is empty");

  const opfDir = path.posix.dirname(opfPath.replace(/\\/g, "/"));
  const itemById = new Map(manifestItems.map((it) => [it.id, it]));
  const sections = [];

  for (const spineItem of spineItems) {
    const item = itemById.get(spineItem.idref);
    if (!item || !isHtmlItem(item)) continue;
    if (/\bnav\b/i.test(String(item.properties || ""))) continue;
    if (isSkippableName(item.id) || isSkippableName(fileStem(item.href))) continue;

    const html = readZipText(zip, resolveZipPath(opfDir, item.href));
    if (!html) continue;
    const title = extractHtmlHeading(html) || fileStem(item.href);
    const text = cleanText(htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "a", options: { ignoreHref: true } },
      ],
    }));
    if (text) sections.push({ title: title.replace(/\s+/g, " ").trim(), text });
  }

  if (!sections.length) throw new Error("EPUB parsed to zero sections");

  return {
    metadata: {
      title: readXmlText(pkg?.metadata?.["dc:title"]),
      author: readXmlText(pkg?.metadata?.["dc:creator"]),
    },
    sections,
    cover: findCover(zip, pkg, manifestItems, opfDir),
  };
}

module.exports = { parseEpub, cleanText };
