import { test } from "node:test";
import assert from "node:assert";
import {
  EXPORT_COLUMNS,
  resolveColumns,
  parseTrees,
  toCsv,
  buildPdf,
} from "../src/services/export.js";

test("resolveColumns returns the default set when no columns are sent", () => {
  const columns = resolveColumns(undefined);
  assert.ok(columns.length > 0);
  assert.ok(columns.length < EXPORT_COLUMNS.length);
  assert.ok(columns.every((c) => c.default));
});

test("resolveColumns supports all, keeps order, removes duplicates", () => {
  assert.strictEqual(resolveColumns("all").length, EXPORT_COLUMNS.length);
  const picked = resolveColumns("name,serial,name,gender");
  assert.deepStrictEqual(
    picked.map((c) => c.key),
    ["name", "serial", "gender"],
  );
});

test("resolveColumns rejects unknown columns", () => {
  assert.throws(() => resolveColumns("name,notAColumn"), /Unknown column/);
});

test("parseTrees validates and normalises tree names", () => {
  assert.deepStrictEqual(parseTrees("egypt, JORDAN,EGYPT"), [
    "EGYPT",
    "JORDAN",
  ]);
  assert.strictEqual(parseTrees(""), null);
  assert.throws(() => parseTrees("SYRIA"), /Unknown tree/);
});

test("CSV is UTF-8 with BOM, CRLF, Arabic headers and escaping", () => {
  const columns = resolveColumns("name,gender");
  const csv = toCsv(
    columns,
    [{ name: 'محمد "الكبير"', gender: "M" }],
    "ar",
  );
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("\r\n"));
  assert.ok(csv.includes('"الاسم"'));
  assert.ok(csv.includes('"الجنس"'));
  assert.ok(csv.includes('"ذكر"'));
  assert.ok(csv.includes('""'));
  assert.ok(csv.includes('"محمد ""الكبير"""'));
});

test("CSV neutralises spreadsheet formula injection", () => {
  const columns = resolveColumns("name");
  const csv = toCsv(columns, [{ name: "=HYPERLINK(1)" }], "en");
  assert.ok(csv.includes('"\'=HYPERLINK(1)"'));
});

test("PDF is generated with the bundled Arabic font", async () => {
  const columns = resolveColumns("serial,name,fatherName");
  const pdf = await buildPdf({
    columns,
    rows: [
      {
        serial: "1-2-3",
        name: "محمد فرج الصياغ",
        fatherName: "فرج ميخائيل حنا",
      },
    ],
    lang: "ar",
    trees: ["EGYPT"],
  });
  assert.strictEqual(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
});
