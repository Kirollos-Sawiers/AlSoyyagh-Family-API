import { ZodError } from "zod";
import multer from "multer";
import { HttpError } from "../utils/errors.js";

export const notFoundHandler = (req, res) =>
  res
    .status(404)
    .json({
      error: {
        code: "NOT_FOUND",
        message: `Route not found: ${req.method} ${req.path}`,
      },
    });

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res
      .status(err.status)
      .json({
        error: { code: err.code, message: err.message, details: err.details },
      });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Some fields are invalid.",
        details: err.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Image is too large (max 2 MB)."
        : err.message;
    return res.status(400).json({ error: { code: "UPLOAD_ERROR", message } });
  }
  if (err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({
        error: { code: "BAD_JSON", message: "Request body is not valid JSON." },
      });
  }
  if (err.code === "23505") {
    return res
      .status(409)
      .json({
        error: { code: "CONFLICT", message: "This record already exists." },
      });
  }
  console.error(err);
  res
    .status(500)
    .json({
      error: {
        code: "SERVER_ERROR",
        message: "Something went wrong on the server.",
      },
    });
}
