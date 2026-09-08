/**
 * FSRS（ts-fsrs）封装：卡片创建、整轮结果评分与持久化格式。
 * 理解选择只是诊断信号；只有完整学习轮结束后，session-service 才能调用 grade。
 */
import {
  fsrs as createFsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";

export const params = generatorParameters({
  enable_fuzz: true,
  request_retention: 0.9,
});

export const scheduler = createFsrs(params);

export const RATINGS = { good: Rating.Good, hard: Rating.Hard, again: Rating.Again, easy: Rating.Easy } as const;
export type RatingKey = keyof typeof RATINGS;

export function newCard(now?: Date): Card {
  return createEmptyCard(now);
}

export function grade(card: Card, rating: RatingKey, now = new Date()): { card: Card } {
  const result = scheduler.next(card, now, RATINGS[rating] as Grade);
  return { card: result.card };
}

/** Mastery 推导：New / Learning / Familiar / Reviewing / Mastered */
export function deriveMastery(card: Card, introDone: boolean): string {
  if (card.state === State.New && !introDone) return "new";
  if (card.state === State.Learning) return introDone ? "familiar" : "learning";
  if (card.state === State.Review || card.state === State.Relearning) {
    if (card.stability > 90 && card.lapses === 0) return "mastered";
    if (card.stability >= 10) return "reviewing";
    return "familiar";
  }
  return introDone ? "familiar" : "new";
}

export function isDue(card: Card, now = new Date()): boolean {
  if (card.state === State.New) return false;
  return new Date(card.due).getTime() <= now.getTime();
}

export type { Card };
