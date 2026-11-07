import { Router } from "express";
import {
  requireLogin,
  canAccessTree,
  assertTreeAccess,
} from "../../middleware/auth.js";
import { TREES } from "../../utils/constants.js";
import { HttpError, badRequest } from "../../utils/errors.js";
import { audit } from "../../utils/audit.js";
import {
  EXPORT_COLUMNS,
  resolveColumns,
  parseTrees,
  fetchMembers,
  toCsv,
  buildPdf,
} from "../../services/export.js";

const router = Router();
router.use(requireLogin);

// Metadata the frontend needs to build the column picker.
router.get("/columns", (_req, res) => {
  res.json({
    columns: EXPORT_COLUMNS.map((c) => ({
      key: c.key,
      label: c.label,
      type: c.type,
      default: c.default,
    })),
    trees: TREES,
    formats: ["csv", "pdf"],
    languages: ["ar", "en"],
  });
});

// GET /api/exports/members?format=csv|pdf&trees=EGYPT,JORDAN&columns=name,serial&lang=ar
router.get("/members", async (req, res) => {
  const format = String(req.query.format || "").toLowerCase();
  if (!["csv", "pdf"].includes(format)) {
    throw badRequest("format must be csv or pdf.");
  }
  const lang = req.query.lang === "en" ? "en" : "ar";

  const requestedTrees = parseTrees(req.query.trees);
  let trees;
  if (requestedTrees) {
    for (const tree of requestedTrees) {
      await assertTreeAccess(req.user, tree);
    }
    trees = requestedTrees;
  } else {
    trees = [];
    for (const tree of TREES) {
      if (await canAccessTree(req.user, tree)) trees.push(tree);
    }
    if (!trees.length) {
      throw new HttpError(
        403,
        "TREE_ACCESS_REQUIRED",
        "You need approval to view a family tree before exporting it.",
      );
    }
  }

  const columns = resolveColumns(req.query.columns);
  const rows = await fetchMembers(trees, columns);

  const body =
    format === "csv"
      ? toCsv(columns, rows, lang)
      : await buildPdf({ columns, rows, lang, trees });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `soyyagh-members-${trees
    .map((t) => t.toLowerCase())
    .join("-")}-${stamp}.${format}`;

  await audit(
    null,
    req.user.id,
    "MEMBERS_EXPORTED",
    "members",
    trees.join(","),
    {
      format,
      trees,
      columns: columns.map((c) => c.key),
      count: rows.length,
      lang,
    },
  );

  res.setHeader(
    "Content-Type",
    format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-store");
  res.send(body);
});

export default router;
