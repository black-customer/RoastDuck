import type {StructuredAiRequest} from '@/lib/ai/contracts';
export function relatedQuestionMock(request:StructuredAiRequest<unknown>){
  const input=JSON.parse(request.input);
  return {promptEn:'What would help you settle into a new routine?',promptZh:'什么会帮助你适应新的日常安排？',targetSentenceIds:input.targets.slice(0,1).map((t:{id:string})=>t.id),targetMemoryIds:[],rationaleZh:'隔离模拟：将已学表达放入新的日常情境。'};
}
