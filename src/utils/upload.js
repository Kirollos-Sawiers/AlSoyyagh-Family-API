import multer from 'multer';
import { badRequest } from './errors.js';

// Images are kept in memory (max 2 MB) and stored in the database.
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// Check the real file signature ("magic bytes"), not just the name the browser sent.
export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function validateImage(file) {
  if (!file) return null;
  const mime = detectImageMime(file.buffer);
  if (!mime) throw badRequest('Image must be a JPG, PNG or WEBP file.');
  return { buffer: file.buffer, mime };
}