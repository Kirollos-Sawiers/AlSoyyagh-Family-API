import { query } from "../config/db.js";
import { HttpError, notFound, badRequest } from "../utils/errors.js";

// camelCase (API) -> snake_case (database) for the fields people may edit
export const EDITABLE = {
  name: "name",
  nickname: "nickname",
  gender: "gender",
  carriesFamilyName: "carries_family_name",
  dateOfBirth: "date_of_birth",
  dateOfDeath: "date_of_death",
  isDeceased: "is_deceased",
  bio: "bio",
  birthPlace: "birth_place",
  residence: "residence",
  occupation: "occupation",
  photoUrl: "photo_url",
  notes: "notes",
};

const blankToNull = (v) =>
  typeof v === "string" && v.trim() === "" ? null : v;

export const toSummary = (r) => ({
  id: r.id,
  tree: r.tree,
  serial: r.serial,
  name: r.name,
  nickname: r.nickname,
  gender: r.gender,
  carriesFamilyName: r.carries_family_name,
  isDeceased: r.is_deceased,
  dateOfBirth: r.date_of_birth,
  dateOfDeath: r.date_of_death,
  photoUrl: r.photo_url,
  parentId: r.parent_id,
  depth: r.depth,
});

export async function getMemberRow(id, client) {
  const { rows } = await (client || { query }).query(
    "SELECT * FROM members WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw notFound("Member not found.");
  return rows[0];
}

async function spousesOf(memberId) {
  const { rows } = await query(
    `SELECT s.id, s.spouse_name, s.spouse_nickname, s.spouse_member_id, m.tree AS spouse_tree, m.serial AS spouse_serial
       FROM member_spouses s LEFT JOIN members m ON m.id = s.spouse_member_id
      WHERE s.member_id = $1 ORDER BY s.sort_order, s.id`,
    [memberId],
  );
  return rows.map((s) => ({
    id: s.id,
    name: s.spouse_name,
    nickname: s.spouse_nickname,
    memberId: s.spouse_member_id,
    memberSerial: s.spouse_serial,
    memberTree: s.spouse_tree,
  }));
}

// Light card: shown when a name is clicked in the tree
export async function getMemberCard(id) {
  const m = await getMemberRow(id);
  const [spouses, kids] = await Promise.all([
    spousesOf(id),
    query("SELECT count(*)::int AS n FROM members WHERE parent_id = $1", [id]),
  ]);
  return { ...toSummary(m), spouses, childrenCount: kids.rows[0].n };
}

// Everything: shown when "more details" is clicked
export async function getMemberDetails(id) {
  const m = await getMemberRow(id);
  const [spouses, children, siblings, father, mother, parent, linked] =
    await Promise.all([
      spousesOf(id),
      query(
        "SELECT * FROM members WHERE parent_id = $1 ORDER BY serial_parts, sort_index",
        [id],
      ),
      m.parent_id
        ? query(
            "SELECT * FROM members WHERE parent_id = $1 AND id <> $2 ORDER BY serial_parts, sort_index",
            [m.parent_id, id],
          )
        : { rows: [] },
      m.father_id
        ? query("SELECT * FROM members WHERE id=$1", [m.father_id])
        : { rows: [] },
      m.mother_id
        ? query("SELECT * FROM members WHERE id=$1", [m.mother_id])
        : { rows: [] },
      m.parent_id
        ? query("SELECT * FROM members WHERE id=$1", [m.parent_id])
        : { rows: [] },
      m.linked_member_id
        ? query("SELECT id, tree, serial, name FROM members WHERE id=$1", [
            m.linked_member_id,
          ])
        : { rows: [] },
    ]);
  const brief = (r) =>
    r
      ? {
          id: r.id,
          serial: r.serial,
          name: r.name,
          gender: r.gender,
          isDeceased: r.is_deceased,
        }
      : null;
  return {
    ...toSummary(m),
    bio: m.bio,
    birthPlace: m.birth_place,
    residence: m.residence,
    occupation: m.occupation,
    notes: m.notes,
    father: father.rows[0]
      ? brief(father.rows[0])
      : m.father_name
        ? { id: null, name: m.father_name }
        : null,
    mother: mother.rows[0]
      ? brief(mother.rows[0])
      : m.mother_name
        ? { id: null, name: m.mother_name }
        : null,
    parent: brief(parent.rows[0]),
    spouses,
    children: children.rows.map(brief),
    siblings: siblings.rows.map(brief),
    linkedMember: linked.rows[0]
      ? {
          id: linked.rows[0].id,
          tree: linked.rows[0].tree,
          serial: linked.rows[0].serial,
          name: linked.rows[0].name,
        }
      : null,
    needsReview: m.needs_review,
    sourceCell: m.source_cell,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

// Compact nested tree below a member (the member itself + all descendants)
export async function getBranch(rootId, maxDepth = 50) {
  const { rows } = await query(
    `WITH RECURSIVE sub AS (
        SELECT m.*, 0 AS lvl FROM members m WHERE m.id = $1
        UNION ALL
        SELECT c.*, sub.lvl + 1 FROM members c JOIN sub ON c.parent_id = sub.id WHERE sub.lvl < $2
     )
     SELECT sub.id, sub.tree, sub.serial, sub.serial_parts, sub.sort_index, sub.parent_id, sub.name, sub.nickname, sub.gender,
            sub.carries_family_name, sub.is_deceased, sub.date_of_birth, sub.date_of_death, sub.photo_url, sub.depth, sub.lvl,
            (SELECT count(*)::int FROM members k WHERE k.parent_id = sub.id) AS children_count,
            COALESCE((SELECT json_agg(s.spouse_name ORDER BY s.sort_order, s.id) FROM member_spouses s WHERE s.member_id = sub.id), '[]'::json) AS spouses
       FROM sub ORDER BY sub.lvl, sub.serial_parts, sub.sort_index`,
    [rootId, maxDepth],
  );
  if (!rows.length) throw notFound("Member not found.");
  const nodes = new Map();
  for (const r of rows) {
    nodes.set(r.id, {
      ...toSummary(r),
      spouses: r.spouses,
      childrenCount: r.children_count,
      children: [],
    });
  }
  for (const r of rows) {
    if (r.id !== rootId && nodes.has(r.parent_id))
      nodes.get(r.parent_id).children.push(nodes.get(r.id));
  }
  return nodes.get(rootId);
}

// ── Writing ──────────────────────────────────────────────────────────

async function replaceSpouses(client, memberId, spouses) {
  await client.query("DELETE FROM member_spouses WHERE member_id = $1", [
    memberId,
  ]);
  let order = 0;
  for (const s of spouses) {
    let name = s.name;
    if (s.memberId) {
      const { rows } = await client.query(
        "SELECT name FROM members WHERE id=$1",
        [s.memberId],
      );
      if (!rows[0])
        throw badRequest(`Spouse member ${s.memberId} does not exist.`);
      name = name || rows[0].name;
    }
    if (!name) throw badRequest("Each spouse needs a name.");
    await client.query(
      `INSERT INTO member_spouses (member_id, spouse_member_id, spouse_name, spouse_nickname, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        memberId,
        s.memberId ?? null,
        name,
        blankToNull(s.nickname) ?? null,
        order++,
      ],
    );
  }
}

// Apply an edit to an existing member (inside a transaction `client`)
export async function applyEdit(client, memberId, data, userId) {
  await getMemberRow(memberId, client);
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(EDITABLE)) {
    if (data[key] !== undefined) {
      vals.push(blankToNull(data[key]));
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (data.dateOfDeath && data.isDeceased === undefined) {
    sets.push("is_deceased = TRUE");
  }
  if (sets.length) {
    vals.push(userId, memberId);
    await client.query(
      `UPDATE members SET ${sets.join(", ")}, updated_by = $${vals.length - 1}, updated_at = now() WHERE id = $${vals.length}`,
      vals,
    );
  }
  if (data.spouses) await replaceSpouses(client, memberId, data.spouses);
  return memberId;
}

// Add a new child below `parentId`. The serial number is generated here, continuing the hierarchy.
export async function applyAddChild(client, parentId, data, userId) {
  const { rows } = await client.query(
    "SELECT * FROM members WHERE id = $1 FOR UPDATE",
    [parentId],
  );
  const parent = rows[0];
  if (!parent) throw notFound("Parent member not found.");

  // next free number among the parent's children
  const last = await client.query(
    `SELECT COALESCE(MAX(serial_parts[array_length(serial_parts,1)]), 0) AS n FROM members WHERE parent_id = $1`,
    [parentId],
  );
  let n = Number(last.rows[0].n) + 1;
  let serial;
  for (;;) {
    serial = parent.serial === "0" ? String(n) : `${parent.serial}-${n}`;
    const taken = await client.query(
      "SELECT 1 FROM members WHERE tree=$1 AND serial=$2",
      [parent.tree, serial],
    );
    if (!taken.rowCount) break;
    n++;
  }

  const sortIdx = (
    await client.query(
      "SELECT COALESCE(MAX(sort_index),0)+1 AS n FROM members WHERE tree=$1",
      [parent.tree],
    )
  ).rows[0].n;
  const gender = data.gender ?? "M";

  // the other parent = the parent's only spouse (if there is exactly one, or if one was chosen)
  const spouseRows = (
    await client.query(
      "SELECT * FROM member_spouses WHERE member_id=$1 ORDER BY sort_order,id",
      [parentId],
    )
  ).rows;
  let other = null;
  if (data.otherParentSpouseId) {
    other = spouseRows.find((s) => s.id === data.otherParentSpouseId);
    if (!other)
      throw badRequest("otherParentSpouseId is not a spouse of this member.");
  } else if (spouseRows.length === 1) {
    other = spouseRows[0];
  }
  const parentIsMale = parent.gender !== "F";
  const father_id = parentIsMale
    ? parent.id
    : (other?.spouse_member_id ?? null);
  const mother_id = parentIsMale
    ? (other?.spouse_member_id ?? null)
    : parent.id;
  const father_name = parentIsMale
    ? null
    : other && !other.spouse_member_id
      ? other.spouse_name
      : null;
  const mother_name = parentIsMale
    ? other && !other.spouse_member_id
      ? other.spouse_name
      : null
    : null;

  const carries =
    data.carriesFamilyName ??
    (parent.carries_family_name && parent.gender !== "F");
  const isDeceased = data.isDeceased ?? Boolean(data.dateOfDeath);

  const ins = await client.query(
    `INSERT INTO members (tree, serial, serial_parts, depth, sort_index, parent_id, name, nickname, gender, carries_family_name,
        date_of_birth, date_of_death, is_deceased, bio, birth_place, residence, occupation, photo_url, notes,
        father_id, mother_id, father_name, mother_name, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)
     RETURNING id`,
    [
      parent.tree,
      serial,
      serial.split("-").map(Number),
      parent.depth + 1,
      sortIdx,
      parent.id,
      data.name,
      blankToNull(data.nickname) ?? null,
      gender,
      carries,
      blankToNull(data.dateOfBirth) ?? null,
      blankToNull(data.dateOfDeath) ?? null,
      isDeceased,
      blankToNull(data.bio) ?? null,
      blankToNull(data.birthPlace) ?? null,
      blankToNull(data.residence) ?? null,
      blankToNull(data.occupation) ?? null,
      blankToNull(data.photoUrl) ?? null,
      blankToNull(data.notes) ?? null,
      father_id,
      mother_id,
      father_name,
      mother_name,
      userId,
    ],
  );
  const newId = ins.rows[0].id;
  if (data.spouses?.length) await replaceSpouses(client, newId, data.spouses);
  return newId;
}

// the path from the top ancestor down to a member (used to open the right branch after a search)
export async function getAncestors(id) {
  const { rows } = await query(
    `WITH RECURSIVE up AS (
        SELECT id, parent_id, serial, name, depth, 0 AS step FROM members WHERE id = $1
        UNION ALL
        SELECT p.id, p.parent_id, p.serial, p.name, p.depth, up.step + 1 FROM members p JOIN up ON p.id = up.parent_id
     ) SELECT id, serial, name, depth FROM up ORDER BY step DESC`,
    [id],
  );
  if (!rows.length) throw notFound("Member not found.");
  return rows;
}

export { HttpError };
