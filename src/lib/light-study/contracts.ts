import { z } from "zod";
import type { LightPhase, LightRating } from "./round";

const id = z.string().trim().min(1).max(160);
export const scopeSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("all")}).strict(),
  z.object({type:z.literal("question"),id}).strict(),
  z.object({type:z.literal("material"),id}).strict(),
]);
export type LightScope = z.infer<typeof scopeSchema>;
export const modeSchema = z.enum(["learn","review"]);
export type LightMode = z.infer<typeof modeSchema>;
export const createLightSchema = z.object({scope:scopeSchema, mode:modeSchema, clientRequestId:id,resumeSessionId:id.optional()}).strict();
const base = {clientEventId:id, version:z.number().int().nonnegative()};
export const lightEventSchema = z.discriminatedUnion("type", [
  z.object({...base,type:z.literal("reveal")}).strict(),
  z.object({...base,type:z.literal("advance")}).strict(),
  z.object({...base,type:z.literal("rate"),rating:z.enum(["remembered","uncertain","forgot"])}).strict(),
  z.object({...base,type:z.literal("pause")}).strict(),
]);
export type LightEvent = z.infer<typeof lightEventSchema>;
export const LIGHT_RATINGS = {remembered:"good",uncertain:"hard",forgot:"again"} as const;
export interface LightCard {
  itemId:string; materialId:string; materialHash:string; rowIndex:number; progressVersion:number;
  chinese:string; english:string; sentenceZh:string; sentenceEn:string;
  originalEnglish:string; reasonZh:string; sourceTitle:string; sourceHref:string; questionId:string|null;
}
export interface LightView {
  id:string; scope:LightScope; mode:LightMode; status:"active"|"paused"|"completed"; version:number;
  index:number; total:number; revealed:boolean; card:LightCard|null; nextCard:LightCard|null;
  unavailable:string|null; notice:string|null;
  experienceVersion?:"light_study_v1"|"light_study_v2";
  needsUpgrade?:boolean;historyOnly?:boolean;legacySessionId?:string;
  phase?:LightPhase|null; initialTotal?:number; initialIndex?:number;
  questionId?:string|null;
  summary?:Array<{itemId:string;chinese:string;initialRating:LightRating;latestRating:LightRating}>;
}
export interface LightOverview {
  enabled:boolean; scope:LightScope; newCount:number; dueCount:number; totalCount:number; unavailableCount:number;
  defaultMode:LightMode; resumable:Partial<Record<LightMode,{id:string;index:number;total:number}>>;
}
export class LightStudyError extends Error {
  constructor(message:string, public status=409, public code="light_study_error", public current?:LightView) { super(message); }
}
