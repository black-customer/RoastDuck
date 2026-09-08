import {createEmptyCard,fsrs,generatorParameters,Rating,type Card} from "ts-fsrs";
import type {LightRating} from "./round";

export const LIGHT_SCHEDULER_VERSION="light-fsrs-days-v1";
export const lightSchedulerParameters=generatorParameters({request_retention:0.9,enable_short_term:false,enable_fuzz:true});
const scheduler=fsrs(lightSchedulerParameters);
const ratings={remembered:Rating.Good,uncertain:Rating.Hard,forgot:Rating.Again} as const;

/** Diagnostic self-ratings and formal reviews use this independent, day-based policy. */
export function gradeLightCard(stored:string|null,rating:LightRating,now:Date):Card {
  const card:Card=stored?JSON.parse(stored):createEmptyCard(now);
  card.due=new Date(card.due);
  if(card.last_review)card.last_review=new Date(card.last_review);
  return scheduler.next(card,now,ratings[rating]).card;
}
