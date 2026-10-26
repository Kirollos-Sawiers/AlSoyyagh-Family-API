// Imports the family tree from the Excel sheet into the database.
//   npm run db:import:dry   -> only READS the sheet and prints a report (touches nothing)
//   npm run db:import       -> imports (refuses to run if members already exist)
//   node scripts/import-excel.js --reset   -> wipes members and imports again
// Your Excel file is only READ, never modified.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  readWorkbook,
  parseWorksheet,
  buildTree,
} from "../src/utils/parseSheet.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const reset = args.includes("--reset");
const file = resolve(
  args.find((a) => !a.startsWith("--")) || "data/family.xlsx",
);

// which worksheet is which tree (sheet name -> tree code)
const SHEETS = [
  { sheet: "Egypt", tree: "EGYPT", opts: { headCell: "B2" } }, // B2 = the grandfather, no serial in the sheet
  { sheet: "Jordan", tree: "JORDAN", opts: {} },
];

console.log(`📖 Reading ${file}`);
const wb = await readWorkbook(file);
const trees = [];
const report = { file, trees: {}, warnings: [] };

for (const { sheet, tree, opts } of SHEETS) {
  const ws = wb.getWorksheet(sheet);
  if (!ws) throw new Error(`Worksheet "${sheet}" not found in the Excel file.`);
  const parsed = parseWorksheet(ws, tree, opts);
  const built = buildTree(parsed.people, tree, parsed.headRoot);

  // resolve each spouse that carries a serial (= the spouse is also a family member)
  const bySerialFirst = (s) => built.bySerial.get(s)?.[0];
  for (const p of built.list) {
    for (const sp of p.spouses) {
      if (sp.serial) {
        const target = bySerialFirst(sp.serial);
        if (target) sp.targetKey = target.key;
        else
          built.warnings.push({
            type: "SPOUSE_SERIAL_NOT_FOUND",
            person: p.serial,
            spouse: sp.name,
            serial: sp.serial,
          });
      }
    }
  }
  const warnings = [...parsed.warnings, ...built.warnings];
  trees.push({ tree, ...built });
  report.trees[tree] = {
    members: built.list.length,
    female: built.list.filter((p) => p.isFemale).length,
    carryingFamilyName: built.list.filter((p) => p.carriesFamilyName).length,
    maxDepth: Math.max(...built.list.map((p) => p.depth)),
    rootPeople: built.list
      .filter((p) => !p.parentKey)
      .map((p) => `${p.serial} ${p.name}`),
    flaggedForReview: built.list.filter((p) => p.review.length).length,
  };
  report.warnings.push(...warnings.map((w) => ({ tree, ...w })));
}

writeFileSync(
  resolve("data/import-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report.trees, null, 2));
console.log(
  `⚠️  ${report.warnings.length} things in the sheet need a human look (saved in data/import-report.json):`,
);
for (const w of report.warnings) console.log("  -", JSON.stringify(w));

if (dry) {
  console.log("\nDry run finished. Nothing was written to the database.");
  process.exit(0);
}

// ───────────── real import ─────────────
const { pool, tx } = await import("../src/config/db.js");
try {
  const existing = await pool.query("SELECT count(*)::int AS n FROM members");
  if (existing.rows[0].n > 0 && !reset) {
    console.error(
      `❌ The database already has ${existing.rows[0].n} members. Use --reset to wipe and re-import.`,
    );
    process.exitCode = 1;
  } else {
    await tx(async (c) => {
      if (reset) await c.query("TRUNCATE members RESTART IDENTITY CASCADE");
      for (const t of trees) {
        const idOf = new Map(); // key -> database id
        const ordered = [...t.list].sort(
          (a, b) => a.depth - b.depth || a.sortIndex - b.sortIndex,
        );
        for (const p of ordered) {
          const r = await c.query(
            `INSERT INTO members (tree, serial, serial_parts, depth, sort_index, parent_id, name, nickname, gender,
                carries_family_name, notes, source_cell, source_text, needs_review)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [
              t.tree,
              p.serial,
              p.serialParts,
              p.depth,
              p.sortIndex,
              p.parentKey ? idOf.get(p.parentKey) : null,
              p.name,
              p.nickname,
              p.isFemale ? "F" : "M",
              p.carriesFamilyName,
              p.note,
              p.sourceCells.join(", "),
              p.rawText,
              p.review,
            ],
          );
          idOf.set(p.key, r.rows[0].id);
        }

        // spouses (+ the reverse link when the spouse is also a numbered member)
        const have = new Set();
        const rows = [];
        const add = (memberKey, spouseKey, name, nickname) => {
          const mid = idOf.get(memberKey);
          const sid = spouseKey ? idOf.get(spouseKey) : null;
          const dedupe = `${mid}|${sid ?? name}`;
          if (have.has(dedupe)) return;
          have.add(dedupe);
          rows.push([
            mid,
            sid,
            name,
            nickname,
            rows.filter((x) => x[0] === mid).length,
          ]);
        };
        const byKey = new Map(t.list.map((p) => [p.key, p]));
        for (const p of t.list) {
          for (const sp of p.spouses) {
            add(p.key, sp.targetKey, sp.name, sp.nickname);
            if (sp.targetKey) add(sp.targetKey, p.key, p.name, p.nickname);
          }
        }
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          await c.query(
            `INSERT INTO member_spouses (member_id, spouse_member_id, spouse_name, spouse_nickname, sort_order)
             SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::int[])`,
            [0, 1, 2, 3, 4].map((k) => chunk.map((r) => r[k])),
          );
        }

        // father / mother: the numbered parent + that parent's ONLY spouse (if exactly one is known)
        const spouseCount = new Map();
        for (const r of rows)
          spouseCount.set(r[0], (spouseCount.get(r[0]) ?? 0) + 1);
        for (const p of t.list) {
          if (!p.parentKey) continue;
          const parent = byKey.get(p.parentKey);
          const pid = idOf.get(parent.key);
          const mine = rows.filter((r) => r[0] === pid);
          const other = mine.length === 1 ? mine[0] : null;
          const parentIsMale = !parent.isFemale;
          const set = parentIsMale
            ? {
                father_id: pid,
                mother_id: other?.[1] ?? null,
                mother_name: other && !other[1] ? other[2] : null,
                father_name: null,
              }
            : {
                mother_id: pid,
                father_id: other?.[1] ?? null,
                father_name: other && !other[1] ? other[2] : null,
                mother_name: null,
              };
          await c.query(
            "UPDATE members SET father_id=$1, mother_id=$2, father_name=$3, mother_name=$4 WHERE id=$5",
            [
              set.father_id,
              set.mother_id,
              set.father_name,
              set.mother_name,
              idOf.get(p.key),
            ],
          );
        }
        t.idOf = idOf;
      }

      // The sheet says Jordan "فرج (1-1) هاجر إلى مصر" = the head of the Egypt tree. Link the two records.
      const eg = trees.find((x) => x.tree === "EGYPT");
      const jo = trees.find((x) => x.tree === "JORDAN");
      const faraj = jo.list.find(
        (p) => p.serial === "1-1" && /مصر/.test(p.note || ""),
      );
      const head = eg.list.find((p) => p.serial === "0");
      if (faraj && head) {
        await c.query("UPDATE members SET linked_member_id=$2 WHERE id=$1", [
          jo.idOf.get(faraj.key),
          eg.idOf.get(head.key),
        ]);
        await c.query("UPDATE members SET linked_member_id=$2 WHERE id=$1", [
          eg.idOf.get(head.key),
          jo.idOf.get(faraj.key),
        ]);
        console.log("🔗 Linked Jordan 1-1 (Faraj) with the Egypt head.");
      }
    });
    const total = await pool.query(
      "SELECT tree, count(*)::int AS n FROM members GROUP BY tree ORDER BY tree",
    );
    console.log(
      "✅ Import finished:",
      total.rows.map((r) => `${r.tree}=${r.n}`).join(", "),
    );
  }
} catch (e) {
  console.error("❌ Import failed (nothing was saved):", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
