import bcrypt from "bcryptjs";
import crypto from "node:crypto";

export const hashPassword = (plain) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// A readable temporary password, e.g. "Tiger-4821-Maple"
const WORDS = [
  "Tiger",
  "Maple",
  "Cedar",
  "Falcon",
  "River",
  "Olive",
  "Amber",
  "Coral",
  "Lotus",
  "Palm",
  "Sand",
  "Nile",
];
export function generateTempPassword() {
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${w()}-${crypto.randomInt(1000, 10000)}-${w()}`;
}
