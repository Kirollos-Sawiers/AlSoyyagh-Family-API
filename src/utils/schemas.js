import { z } from "zod";
import { ROLES, TREES } from "./constants.js";

const text = (max) => z.string().trim().max(max);
const optText = (max) => text(max).nullable().optional();
const partialDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM or YYYY-MM-DD")
  .or(z.literal(""))
  .nullable();

export const passwordRule = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(100)
  .refine(
    (p) => /[A-Za-z]/.test(p) && /\d/.test(p),
    "Password must contain letters and numbers",
  );

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: passwordRule,
});

export const joinRequestSchema = z.object({
  name: text(150).min(2, "Name is required"),
  phone: text(30).regex(
    /^[+\d][\d\s\-()]{6,29}$/,
    "Phone number looks invalid",
  ),
  email: text(200).email(),
  relation: text(500).min(
    2,
    "Please tell us how you are related to the family",
  ),
});

export const approveJoinSchema = z.object({
  role: z.enum(["ADMIN", "CONTRIBUTOR", "USER"]),
  trees: z
    .array(z.enum(TREES))
    .min(1, "Choose at least one country tree")
    .max(2),
  password: passwordRule.optional(), // if omitted the server generates a temporary one
});

export const rejectSchema = z.object({ reason: optText(500) });

export const updateUserSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .strict()
  .refine((o) => o.role || o.status, "Send role and/or status");

export const setTreesSchema = z.object({
  trees: z.array(z.enum(TREES)).max(2),
});
export const resetPasswordSchema = z.object({
  password: passwordRule.optional(),
});
export const accessRequestSchema = z.object({ tree: z.enum(TREES) });

const spouse = z.object({
  name: text(200).optional(),
  nickname: optText(200),
  memberId: z.number().int().positive().nullable().optional(),
});

const memberFields = z.object({
  name: text(200).min(1, "Name is required"),
  nickname: optText(200),
  gender: z.enum(["M", "F", "U"]),
  carriesFamilyName: z.boolean(),
  dateOfBirth: partialDate,
  dateOfDeath: partialDate,
  isDeceased: z.boolean(),
  bio: optText(5000),
  birthPlace: optText(200),
  residence: optText(200),
  occupation: optText(200),
  photoUrl: z.string().url().max(500).or(z.literal("")).nullable(),
  notes: optText(2000),
  spouses: z.array(spouse).max(10),
});

export const editMemberSchema = memberFields
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, "Nothing to change");

export const addChildSchema = memberFields
  .partial()
  .extend({
    name: memberFields.shape.name,
    otherParentSpouseId: z.number().int().positive().optional(),
  })
  .strict();

export const reviewSchema = z.object({ note: optText(500) });
