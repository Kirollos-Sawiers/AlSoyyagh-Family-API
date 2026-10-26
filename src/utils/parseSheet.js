// Parses the family-tree Excel sheet into clean "person" records.
// It NEVER modifies the Excel file - it only reads it.
//
// Cell grammar (one person per cell):
//   Name ( optional-nickname  SERIAL ) [*] [+ Spouse Name ( SERIAL ) [*]] [+ another spouse ...]
//   - SERIAL looks like 1-1-3-2 (the position in the family hierarchy)
//   - "*" means female
//   - the part after "+" is the spouse (may have its own serial if the spouse is also a family member)
import ExcelJS from 'exceljs';

const TATWEEL = /ـ/g; // Arabic decorative stretching character
const SERIAL_RE = /(\d+(?:\s*-\s*\d+)*)/;

export const clean = (s) =>
  String(s ?? '')
    .replace(TATWEEL, '')
    .replace(/[ً-ْ]/g, '') // Arabic diacritics (harakat)
    .replace(/\s+/g, ' ')
    .trim();

const normSerial = (s) => s.replace(/\s+/g, '');

// Parse ONE person fragment (either the main person or a spouse).
function parseFragment(fragment) {
  const raw = fragment;
  const isFemale = raw.includes('*');
  let text = raw.replace(/\*/g, ' ');

  let serial = null;
  let nickname = null;
  let note = null;

  // Look at the first (...) group
  const paren = text.match(/\(([^)]*)\)/);
  let name = text;
  if (paren) {
    const inside = paren[1];
    name = text.slice(0, paren.index);
    const after = text.slice(paren.index + paren[0].length);
    const m = inside.match(SERIAL_RE);
    if (m) {
      serial = normSerial(m[1]);
      const alias = clean(inside.replace(m[1], ''));
      if (alias) nickname = alias;
    } else {
      const alias = clean(inside);
      if (alias) nickname = alias;
    }
    const afterClean = clean(after);
    if (afterClean) note = afterClean;
  }
  let typo = false;
  if (!serial) {
    // Typo tolerance: "Name 5-2-1-4 )" (the opening bracket is missing in the sheet)
    const m = text.match(/(\d+(?:\s*-\s*\d+)*)\s*\)/);
    if (m) {
      serial = normSerial(m[1]);
      name = text.slice(0, m.index);
      typo = true;
    }
  }
  name = clean(name.replace(/[\[\]]/g, ''));
  return { name, nickname, serial, isFemale, note, typo };
}

export function parseCell(value) {
  const raw = String(value);
  const parts = raw.split('+');
  const main = parseFragment(parts[0]);
  const spouses = parts
    .slice(1)
    .map(parseFragment)
    .filter((s) => s.name);
  return { raw: clean(raw), main, spouses };
}

const serialParent = (serial) => {
  const p = serial.split('-');
  return p.length > 1 ? p.slice(0, -1).join('-') : null;
};

// Reads one worksheet and returns { people, warnings }
export function parseWorksheet(ws, treeCode, opts = {}) {
  const people = new Map(); // serial -> person
  const warnings = [];
  const rootCell = { serial: opts.rootSerial ?? null };
  let sortIndex = 0;
  let headRoot = null;

  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      if (v === null || v === undefined) return;
      // merged cells repeat the same value in every covered cell: only read the top-left (master) one
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;
      const text = typeof v === 'object' ? (v.richText ? v.richText.map((r) => r.text).join('') : String(v.result ?? v.text ?? '')) : String(v);
      if (!clean(text)) return;
      const ref = `${ws.name}!${cell.address}`;
      const parsed = parseCell(text);
      const { main } = parsed;

      if (!main.serial) {
        // Special case 1: the very first big cell is the head of the Egyptian tree (no serial).
        if (opts.headCell && cell.address === opts.headCell) {
          headRoot = { parsed, ref, sortIndex: sortIndex++ };
          return;
        }
        warnings.push({ type: 'NO_SERIAL', ref, text: parsed.raw });
        return;
      }

      const serial = main.serial;
      const existing = people.get(serial);
      const sameName = existing && existing.name === main.name;
      if (existing && sameName) {
        // Same person written in several cells (e.g. several wives): merge the spouses
        for (const s of parsed.spouses) existing.spouses.push(s);
        existing.sourceCells.push(ref);
        return;
      }
      let key = serial;
      const review = [];
      if (existing) {
        // Two DIFFERENT people carry the same serial in the sheet (a typo in the sheet).
        // We keep both (nothing is dropped) and flag them for review.
        let n = 2;
        while (people.has(`${serial}#${n}`)) n++;
        key = `${serial}#${n}`;
        existing.review.push(`DUPLICATE_SERIAL: same serial as ${main.name} (${ref})`);
        review.push(`DUPLICATE_SERIAL: same serial as ${existing.name} (${existing.sourceCells[0]})`);
        warnings.push({ type: 'DUPLICATE_SERIAL_DIFFERENT_NAME', ref, serial, a: existing.name, b: main.name });
      }
      if (main.typo) {
        review.push('SERIAL_TYPO_IN_SHEET: bracket missing, serial read anyway');
        warnings.push({ type: 'TYPO_TOLERATED', ref, text: parsed.raw });
      }
      people.set(key, {
        key,
        tree: treeCode,
        serial,
        name: main.name,
        nickname: main.nickname,
        isFemale: main.isFemale,
        note: main.note,
        spouses: [...parsed.spouses],
        rawText: parsed.raw,
        sourceCells: [ref],
        row: cell.master ? cell.master.row : cell.row,
        col: cell.col,
        review,
        sortIndex: sortIndex++,
      });
    });
  });

  return { people, warnings, headRoot, rootCell };
}

export async function readWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

// Build the final list for a tree (adds parent links, depth, family-name flag)
export function buildTree(people, treeCode, headRoot) {
  const list = [];
  const warnings = [];

  if (headRoot) {
    const { main } = headRoot.parsed;
    // Head of the Egypt tree. He has no serial in the sheet; we give him "0"
    // so that the serials 1..8 are his eight children.
    list.push({
      key: '0',
      tree: treeCode,
      serial: '0',
      name: main.name,
      nickname: main.nickname, // the family name written in brackets, e.g. ( الصياغ )
      isFemale: false,
      note: null,
      spouses: [],
      rawText: headRoot.parsed.raw,
      sourceCells: [headRoot.ref],
      row: 2,
      col: 2,
      review: [],
      sortIndex: -1,
    });
  }
  for (const p of people.values()) list.push(p);

  // serial -> all people carrying that serial (normally exactly one)
  const bySerial = new Map();
  for (const p of list) {
    if (!bySerial.has(p.serial)) bySerial.set(p.serial, []);
    bySerial.get(p.serial).push(p);
  }

  for (const p of list) {
    p.parentKey = null;
    if (p.serial === '0') continue;
    let ps = serialParent(p.serial);
    if (ps === null) ps = bySerial.has('0') ? '0' : null; // 1..8 are children of the head
    let climbed = false;
    // If the parent serial does not exist in the sheet, climb up to the nearest ancestor that does
    while (ps && !bySerial.has(ps)) {
      climbed = true;
      ps = serialParent(ps) ?? (bySerial.has('0') ? '0' : null);
    }
    if (!ps) continue; // a real root (e.g. Jordan "1" and "2")
    const candidates = bySerial.get(ps);
    let parent = candidates[0];
    if (candidates.length > 1) {
      // choose the candidate that sits closest above the child, in the column to its left
      parent =
        candidates
          .filter((c) => c.row <= p.row)
          .sort((a, b) => b.row - a.row)[0] || candidates[0];
    }
    p.parentKey = parent.key;
    if (climbed) {
      p.review.push(`PARENT_MISSING_IN_SHEET: attached to nearest existing ancestor ${ps}`);
      warnings.push({ type: 'MISSING_PARENT', serial: p.serial, name: p.name, attachedTo: ps });
    }
  }

  const byKey = new Map(list.map((p) => [p.key, p]));
  const depthOf = (p) => (p.parentKey ? depthOf(byKey.get(p.parentKey)) + 1 : 0);
  for (const p of list) {
    p.depth = depthOf(p);
    p.serialParts = p.serial.split('-').map(Number);
  }
  // family-name rule: carries the family name when the whole chain of ancestors is male
  // (a woman is born with the family name; her own children do not carry it)
  const carries = (p) => {
    if (p.carriesFamilyName !== undefined) return p.carriesFamilyName;
    if (!p.parentKey) return (p.carriesFamilyName = true);
    const par = byKey.get(p.parentKey);
    return (p.carriesFamilyName = carries(par) && !par.isFemale);
  };
  for (const p of list) carries(p);
  return { list, warnings, bySerial, byKey };
}