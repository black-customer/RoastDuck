import type {SentenceCard} from './contracts';

/** An unavailable unit stays in workspace context, but must never be a correct audio/text example. */
export function safeMaterialPresentation(cards:SentenceCard[],pending:Array<{chinese:string;reason:string}>=[]){
  const sentences=cards.filter(card=>!card.unavailable).map(card=>({id:card.id,chinese:card.chinese,english:card.english,notes:card.notes}));
  const needsAttention=[...pending.map(item=>({intentZh:item.chinese,reasonZh:item.reason})),
    ...cards.filter(card=>card.unavailable).map(card=>({intentZh:`第 ${card.ordinal+1} 句`,reasonZh:card.unavailable!}))];
  return {sentences,referenceText:sentences.map(card=>card.english).join('\n'),needsAttention};
}
