import { z } from "zod";
import { SceneSchema, UlidSchema } from "./schema";
const branch = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[\p{L}\p{N}_-]+$/u);
const ref = { branch, head: UlidSchema };
const source = { source: UlidSchema, sourceBranch: branch.optional() };
export const RevisionRequest = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("state"), branch: branch.default("main") })
    .strict(),
  z.object({ action: z.literal("fork"), branch, from: UlidSchema }).strict(),
  z
    .object({
      action: z.literal("save"),
      ...ref,
      title: z.string().trim().min(1).max(80),
      scene: SceneSchema,
    })
    .strict(),
  z.object({ action: z.literal("review"), ...ref, ...source }).strict(),
  z.object({ action: z.literal("accept"), ...ref, ...source }).strict(),
  z.object({ action: z.literal("revert"), ...ref }).strict(),
  z.object({ action: z.literal("replay"), ...ref }).strict(),
]);
export type RevisionInput = z.input<typeof RevisionRequest>;
