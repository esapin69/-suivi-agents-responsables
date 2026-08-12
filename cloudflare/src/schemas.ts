import { z } from "zod";

const cleanText = (maximum: number) => z.string().trim().max(maximum);
const requiredText = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const recordVersion = z.number().int().positive();

export const loginSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

const traineeBaseSchema = z.object({
  firstName: requiredText(80),
  lastName: requiredText(80),
  email: cleanText(180).email().or(z.literal("")).default(""),
  phone: cleanText(40).default(""),
  school: cleanText(180).default(""),
  startDate: isoDate,
  endDate: isoDate,
  tutorUserId: cleanText(100).nullable().optional(),
  tutorName: cleanText(160).default(""),
  arrivalNotes: cleanText(3000).default(""),
}).strict();

export const traineeCreateSchema = traineeBaseSchema.refine(value => value.endDate >= value.startDate, { path: ["endDate"], message: "La date de fin doit suivre la date de début." });

export const traineeUpdateSchema = traineeBaseSchema.partial().extend({
  expectedVersion: recordVersion,
}).strict().refine(value => !value.startDate || !value.endDate || value.endDate >= value.startDate, { path: ["endDate"], message: "La date de fin doit suivre la date de début." });

export const observationCreateSchema = z.object({
  category: z.enum(["AUTONOMIE", "TECHNIQUE_MANUTENTION", "SECURITE_HYGIENE", "COMMUNICATION", "ORGANISATION", "COMPORTEMENT_PROFESSIONNEL", "AUTRE"]),
  observedOn: isoDate,
  content: requiredText(5000),
  expectedVersion: recordVersion,
}).strict();

export const observationUpdateSchema = observationCreateSchema.partial().extend({
  expectedVersion: recordVersion,
}).strict();

export const selfSectionSchema = z.object({
  expectations: cleanText(5000).default(""),
  progress: cleanText(5000).default(""),
  feedback: cleanText(5000).default(""),
  comments: cleanText(5000).default(""),
  expectedVersion: recordVersion,
}).strict();

export const ratingSchema = z.union([z.number().int().min(1).max(4), z.literal("NA")]);

export const finalEvaluationSchema = z.object({
  ratings: z.object({
    autonomy: ratingSchema,
    techniqueHandling: ratingSchema,
    safetyHygiene: ratingSchema,
    communication: ratingSchema,
    organization: ratingSchema,
    professionalBehavior: ratingSchema,
  }).strict(),
  strengths: requiredText(5000),
  improvements: requiredText(5000),
  summary: cleanText(5000).default(""),
  expectedVersion: recordVersion,
}).strict();

export const signatureSchema = z.object({
  signatureDataUrl: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/),
  expectedVersion: recordVersion,
  signerName: cleanText(160).optional(),
}).strict();

export const shareLinkSchema = z.object({
  expiresDays: z.number().int().min(1).max(365).default(90),
}).strict();

export const shareExchangeSchema = z.object({ token: z.string().min(32).max(200) }).strict();

export const closeSchema = z.object({ expectedVersion: recordVersion }).strict();
export const newVersionSchema = z.object({ expectedVersion: recordVersion }).strict();
