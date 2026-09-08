import {expect,it} from 'vitest';
import {State} from 'ts-fsrs';
import {gradeLightCard,lightSchedulerParameters,LIGHT_SCHEDULER_VERSION} from '@/lib/light-study/scheduler';
import {newCard,grade} from '@/lib/learning/fsrs';

it('new self-ratings create independent day-based review cards, with a longer interval for stronger recall',()=>{
  const now=new Date('2026-09-08T08:00:00Z');
  const cards=(['forgot','uncertain','remembered'] as const).map(rating=>gradeLightCard(null,rating,now));
  expect(lightSchedulerParameters).toMatchObject({request_retention:.9,enable_short_term:false,enable_fuzz:true});
  expect(LIGHT_SCHEDULER_VERSION).toBe('light-fsrs-days-v1');
  for(const card of cards){
    expect(card.state).toBe(State.Review);expect(card.reps).toBe(1);
    expect((card.due.getTime()-now.getTime())/86400000).toBeGreaterThanOrEqual(1);
    expect(card.scheduled_days).toBeGreaterThanOrEqual(1);
  }
  expect(cards[0].scheduled_days).toBeLessThanOrEqual(cards[1].scheduled_days);
  expect(cards[1].scheduled_days).toBeLessThan(cards[2].scheduled_days);
});
it('a legacy short-term card switches only when a new self-rating is supplied and keeps prior repetitions',()=>{
  const earlier=new Date('2026-09-01T08:00:00Z'),legacy=grade(newCard(earlier),'again',earlier).card;
  const stored=JSON.stringify(legacy),now=new Date('2026-09-08T08:00:00Z');
  const updated=gradeLightCard(stored,'uncertain',now);
  expect(JSON.stringify(legacy)).toBe(stored);
  expect(updated.reps).toBe(legacy.reps+1);expect(updated.last_review).toEqual(now);
  expect(updated.scheduled_days).toBeGreaterThanOrEqual(1);expect(updated.state).toBe(State.Review);
});
