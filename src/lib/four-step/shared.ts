import { hashParts } from "@/lib/platform/hash";

export const hash = hashParts;
export class TrainingError extends Error {
  constructor(message: string, readonly status = 409, readonly code = "training_conflict") { super(message); }
}
