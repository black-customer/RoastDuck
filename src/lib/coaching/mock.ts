import type {StructuredAiRequest} from '@/lib/ai/contracts';
/** Explicitly synthetic automation only. Never used as real review evidence. */
export function coachingMock(request:StructuredAiRequest<unknown>):unknown{
  const p=JSON.parse(request.input);
  if(request.schemaName==='coaching_error_reviewer_v1')return {decisions:p.candidates.map((c:{sourceQuote:string},index:number)=>({index,confirmed:true,sourceQuote:c.sourceQuote,reasonZh:'隔离测试：当前证据包含错误构式。',confidence:.9}))};
  const text=String(p.latestUserMessage),wrong=text.includes('used to live alone');
  return {verdict:wrong?'incorrect':/[一-鿿]/.test(text)&&!/[A-Za-z]{2}/.test(text)?'uncertain':'natural',extent:p.correctionHint||/I meant|我想改|刚才/.test(text)?'local_correction':'full_answer',
    messages:[{text:wrong?"For a habit you're comfortable with now, say ‘I'm used to living alone.’ You can try it again, or move on.":'Your meaning comes through. You can try another version, or move on.',translationZh:wrong?'现在已经习惯做某事，用 be used to doing。可以再试一次，也可以继续。':'隔离模拟：可以自由修正或继续。'}],
    findings:wrong?[{kind:'confirmed_error',sourceQuote:'used to live alone',correction:'used to living alone',explanationZh:'表示已经习惯时，be used to 后面接动名词。',memoryKey:'used_to_gerund'}]:[],usedMemoryIds:[]};
}
