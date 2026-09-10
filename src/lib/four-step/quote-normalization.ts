import type {Diagnosis,SelectionSource} from './selection-contracts';

type QuoteField='english'|'chinese'|'raw';
export interface QuoteNormalizationChange {
  unitId:string;
  field:QuoteField;
  sourceField:'actualAnswer'|'intendedMeaningZh'|'rawInput';
  quoteIndex:number;
  quoteText:string;
  fromOccurrence:number;
  toOccurrence:0;
  reason:'unique_exact_quote_invalid_ordinal';
}

/**
 * Repairs only the unambiguous indexing mistake "character offset instead of occurrence ordinal".
 * Quote text and source stay byte-for-byte unchanged. Repeated or missing quotes are left for the
 * normal source/coverage validation to reject. Changes belong alongside the private stage evidence.
 */
export function normalizeUniqueQuoteOccurrences(source:SelectionSource,diagnosis:Diagnosis):{diagnosis:Diagnosis;changes:QuoteNormalizationChange[]}{
  const normalized=structuredClone(diagnosis),changes:QuoteNormalizationChange[]=[];
  const mixed=source.inputFormat==='mixed-v1';
  // Never use a mismatched raw buffer to make an invalid source binding look valid.
  if(mixed&&(!source.rawInput||source.rawInput!==source.actualAnswer))return {diagnosis:normalized,changes};
  for(const unit of normalized.units){
    for(const field of ['english','chinese','raw'] as const){
      if(field==='raw'&&!mixed)continue;
      const sourceField=mixed?'rawInput':field==='english'?'actualAnswer':'intendedMeaningZh';
      const original=source[sourceField];
      if(typeof original!=='string')continue;
      for(const [quoteIndex,quote] of (unit[field]??[]).entries()){
        // A valid unique reference always has ordinal 0. Invalid types and negative numbers are
        // schema errors, not the offset-vs-ordinal confusion this operation is allowed to repair.
        if(!quote.text||!Number.isSafeInteger(quote.occurrence)||quote.occurrence<=0)continue;
        const first=original.indexOf(quote.text);
        if(first<0||original.indexOf(quote.text,first+1)!==-1)continue;
        changes.push({unitId:unit.id,field,sourceField,quoteIndex,quoteText:quote.text,fromOccurrence:quote.occurrence,toOccurrence:0,reason:'unique_exact_quote_invalid_ordinal'});
        quote.occurrence=0;
      }
    }
  }
  return {diagnosis:normalized,changes};
}
