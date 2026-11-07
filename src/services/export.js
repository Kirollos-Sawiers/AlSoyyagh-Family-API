import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import reshaper from "arabic-persian-reshaper";
import bidiFactory from "bidi-js";
import { query } from "../config/db.js";
import { TREES } from "../utils/constants.js";
import { badRequest } from "../utils/errors.js";

const bidi = bidiFactory();
const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(here, "..", "..", "assets", "fonts", "Amiri-Regular.ttf");

// ── Column catalogue ─────────────────────────────────────────────────
// `sql` is a fixed expression (never built from user input); `weight`
// controls how much horizontal space the column gets in the PDF table.
const column = (key, en, ar, sql, opts = {}) => ({
  key,
  label: { en, ar },
  sql,
  weight: opts.weight ?? 1,
  type: opts.type ?? "text",
  default: opts.default ?? true,
  format: opts.format ?? null,
});

const yesNo = (v, lang) =>
  v ? (lang === "ar" ? "نعم" : "Yes") : lang === "ar" ? "لا" : "No";
const genderText = (v, lang) =>
  v === "F"
    ? lang === "ar"
      ? "أنثى"
      : "Female"
    : v === "M"
      ? lang === "ar"
        ? "ذكر"
        : "Male"
      : lang === "ar"
        ? "غير محدد"
        : "Unspecified";
const treeText = (v, lang) =>
  v === "EGYPT"
    ? lang === "ar"
      ? "مصر"
      : "Egypt"
    : v === "JORDAN"
      ? lang === "ar"
        ? "الأردن"
        : "Jordan"
      : v;

export const EXPORT_COLUMNS = [
  column("serial", "Serial", "التسلسل", "m.serial", { weight: 1.2 }),
  column("tree", "Tree", "الفرع", "m.tree", {
    weight: 1.1,
    format: treeText,
  }),
  column("name", "Name", "الاسم", "m.name", { weight: 2.6 }),
  column("nickname", "Nickname", "اللقب", "m.nickname", { weight: 1.5 }),
  column("gender", "Gender", "الجنس", "m.gender", {
    weight: 1,
    format: genderText,
  }),
  column(
    "carriesFamilyName",
    "Carries family name",
    "يحمل اسم العائلة",
    "m.carries_family_name",
    { weight: 1.5, type: "boolean" },
  ),
  column("dateOfBirth", "Date of birth", "تاريخ الميلاد", "m.date_of_birth", {
    weight: 1.5,
  }),
  column("dateOfDeath", "Date of death", "تاريخ الوفاة", "m.date_of_death", {
    weight: 1.5,
  }),
  column("isDeceased", "Deceased", "متوفى", "m.is_deceased", {
    weight: 1,
    type: "boolean",
  }),
  column("birthPlace", "Birth place", "مكان الميلاد", "m.birth_place", {
    weight: 1.7,
  }),
  column("residence", "Residence", "مكان الإقامة", "m.residence", {
    weight: 1.7,
  }),
  column("occupation", "Occupation", "المهنة", "m.occupation", { weight: 1.7 }),
  column(
    "fatherName",
    "Father",
    "الأب",
    "COALESCE((SELECT f.name FROM members f WHERE f.id = m.father_id), m.father_name)",
    { weight: 1.8 },
  ),
  column(
    "motherName",
    "Mother",
    "الأم",
    "COALESCE((SELECT mo.name FROM members mo WHERE mo.id = m.mother_id), m.mother_name)",
    { weight: 1.8 },
  ),
  column(
    "spouses",
    "Spouses",
    "الأزواج",
    "COALESCE((SELECT string_agg(s.spouse_name, '، ' ORDER BY s.sort_order, s.id) FROM member_spouses s WHERE s.member_id = m.id), '')",
    { weight: 2 },
  ),
  column(
    "childrenCount",
    "Children",
    "عدد الأبناء",
    "(SELECT count(*)::int FROM members c WHERE c.parent_id = m.id)",
    { weight: 1, type: "number" },
  ),
  column("bio", "Bio", "نبذة", "m.bio", { weight: 3 }),
  column("notes", "Notes", "ملاحظات", "m.notes", { weight: 2.5 }),
  column("photoUrl", "Photo URL", "رابط الصورة", "m.photo_url", {
    weight: 2,
    default: false,
  }),
  column("depth", "Depth", "العمق", "m.depth", {
    weight: 0.8,
    type: "number",
    default: false,
  }),
  column("createdAt", "Created at", "تاريخ الإضافة", "m.created_at", {
    weight: 1.6,
    default: false,
  }),
  column("updatedAt", "Updated at", "آخر تحديث", "m.updated_at", {
    weight: 1.6,
    default: false,
  }),
];

const COLUMN_BY_KEY = new Map(EXPORT_COLUMNS.map((c) => [c.key, c]));

export function resolveColumns(param) {
  if (param === undefined || String(param).trim() === "") {
    return EXPORT_COLUMNS.filter((c) => c.default);
  }
  const keys = String(param)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keys.length) throw badRequest("Choose at least one column.");
  if (keys.includes("all")) return [...EXPORT_COLUMNS];

  const unknown = keys.filter((k) => !COLUMN_BY_KEY.has(k));
  if (unknown.length) {
    throw badRequest(`Unknown column(s): ${unknown.join(", ")}.`, {
      columns: unknown,
    });
  }
  const seen = new Set();
  const result = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(COLUMN_BY_KEY.get(key));
  }
  return result;
}

export function parseTrees(param) {
  if (param === undefined || String(param).trim() === "") return null;
  const list = [
    ...new Set(
      String(param)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const unknown = list.filter((t) => !TREES.includes(t));
  if (unknown.length) {
    throw badRequest(`Unknown tree(s): ${unknown.join(", ")}. Use EGYPT or JORDAN.`, {
      trees: unknown,
    });
  }
  if (!list.length) throw badRequest("Choose at least one tree.");
  return list;
}

export async function fetchMembers(trees, columns) {
  const select = columns
    .map((c) => `${c.sql} AS "${c.key}"`)
    .join(", ");
  const { rows } = await query(
    `SELECT ${select}
       FROM members m
      WHERE m.tree = ANY($1)
      ORDER BY CASE m.tree WHEN 'EGYPT' THEN 0 ELSE 1 END, m.serial_parts, m.sort_index`,
    [trees],
  );
  return rows;
}

function cellText(row, col, lang) {
  let value = row[col.key];
  if (value instanceof Date) value = value.toISOString();
  if (col.format) value = col.format(value, lang);
  else if (typeof value === "boolean") value = yesNo(value, lang);
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

// ── CSV (UTF-8 with BOM so Excel shows Arabic correctly) ─────────────
function csvCell(value) {
  let text = String(value);
  // Prevent spreadsheet formula injection from user-edited fields.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(columns, rows, lang) {
  const header = columns.map((c) => csvCell(c.label[lang] ?? c.label.en));
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(cellText(row, c, lang))).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// ── PDF: reshape Arabic + run the Unicode bidi algorithm ─────────────
// pdfkit draws glyphs left-to-right, so Arabic must be converted to
// presentation forms and reordered into visual order first.
function visualText(value, lang) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const shaped = reshaper.ArabicShaper.convertArabic(text);
  const levels = bidi.getEmbeddingLevels(shaped, lang === "ar" ? "rtl" : "ltr");
  const chars = shaped.split("");
  for (const [start, end] of bidi.getReorderSegments(shaped, levels)) {
    const segment = chars.slice(start, end + 1).reverse();
    for (let i = 0; i < segment.length; i++) chars[start + i] = segment[i];
  }
  for (const [index, char] of bidi.getMirroredCharactersMap(shaped, levels)) {
    chars[index] = char;
  }
  return chars.join("");
}

export function buildPdf({ columns, rows, lang, trees }) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(FONT_PATH)) {
        throw new Error("Arabic font not found at assets/fonts/Amiri-Regular.ttf");
      }

      const landscape = columns.length > 6;
      const doc = new PDFDocument({
        size: "A4",
        layout: landscape ? "landscape" : "portrait",
        margins: { top: 26, left: 24, right: 24, bottom: 30 },
        bufferPages: true,
        info: {
          Title:
            lang === "ar"
              ? "أعضاء عائلة الصياغ"
              : "Al-Soyyagh Family Members",
          Author: "Al-Soyyagh Family",
        },
      });

      doc.registerFont("Body", FONT_PATH);
      doc.font("Body");

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const title =
        lang === "ar" ? "أعضاء عائلة الصياغ" : "Al-Soyyagh Family Members";
      const treeNames = trees.map((t) => treeText(t, lang)).join(" + ");
      const subtitle =
        lang === "ar"
          ? `${treeNames} — ${new Date().toISOString().slice(0, 10)} — ${rows.length} سجل`
          : `${treeNames} — ${new Date().toISOString().slice(0, 10)} — ${rows.length} records`;
      const align = lang === "ar" ? "right" : "left";

      const left = doc.page.margins.left;
      const usable = doc.page.width - left - doc.page.margins.right;
      const bottom = () => doc.page.height - doc.page.margins.bottom;

      doc.fillColor("#1f2937").fontSize(15).text(visualText(title, lang), left, doc.y, {
        width: usable,
        align,
      });
      doc.moveDown(0.2);
      doc
        .fillColor("#6b7280")
        .fontSize(9)
        .text(visualText(subtitle, lang), left, doc.y, { width: usable, align });
      doc.moveDown(0.7);

      const totalWeight = columns.reduce((sum, c) => sum + c.weight, 0);
      const widths = columns.map((c) => (c.weight / totalWeight) * usable);

      const drawHeader = (y) => {
        const height = 22;
        doc.save();
        doc.rect(left, y, usable, height).fill("#e7dfd0");
        doc.restore();
        doc.fillColor("#111827").fontSize(8.5);
        let x = left;
        columns.forEach((col, i) => {
          doc.text(visualText(col.label[lang] ?? col.label.en, lang), x + 3, y + 6, {
            width: widths[i] - 6,
            align,
            ellipsis: true,
            lineBreak: false,
          });
          x += widths[i];
        });
        return y + height;
      };

      let y = doc.y;
      y = drawHeader(y);

      rows.forEach((row, index) => {
        const values = columns.map((c) => visualText(cellText(row, c, lang), lang));
        doc.fontSize(8);
        const needed = values.map((v, i) =>
          v ? doc.heightOfString(v, { width: widths[i] - 6 }) : 0,
        );
        const rowHeight = Math.min(Math.max(16, Math.max(...needed) + 6), 56);

        if (y + rowHeight > bottom()) {
          doc.addPage();
          y = doc.page.margins.top;
          y = drawHeader(y);
        }

        doc.save();
        doc
          .rect(left, y, usable, rowHeight)
          .fill(index % 2 === 0 ? "#ffffff" : "#faf8f3");
        doc.restore();

        let x = left;
        values.forEach((value, i) => {
          doc.save();
          doc.rect(x, y, widths[i], rowHeight).strokeColor("#e5e0d5").lineWidth(0.5).stroke();
          doc.restore();
          if (value) {
            doc.fillColor("#1f2937").text(value, x + 3, y + 3, {
              width: widths[i] - 6,
              height: rowHeight - 6,
              align,
              ellipsis: true,
            });
          }
          x += widths[i];
        });
        y += rowHeight;
      });

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Allow drawing in the bottom margin without pdfkit adding a new page.
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .fillColor("#9ca3af")
          .fontSize(8)
          .text(`${i + 1} / ${range.count}`, left, doc.page.height - 18, {
            width: usable,
            align: "center",
            lineBreak: false,
          });
        doc.page.margins.bottom = margin;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
