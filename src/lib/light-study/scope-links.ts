import {scopeSchema,type LightScope} from './contracts';
export const DEFAULT_EXPRESSION_SCOPE:LightScope={type:'collection',id:'ielts'};
export function scopeQuery(scope:LightScope){
  const params=new URLSearchParams(scope.type==='all'?{scope:'all'}:{scope:scope.type,id:scope.id});
  if(scope.type==='collection')for(const key of ['questionId','topicId','seasonId'] as const)if(scope[key])params.set(key,scope[key]);
  return params.toString();
}
export function expressionScope(params:Record<string,string|string[]|undefined>){
  return scopeSchema.safeParse(!params.scope?DEFAULT_EXPRESSION_SCOPE:params.scope==='all'?{type:'all'}:{type:params.scope,id:params.id,...(params.scope==='collection'?Object.fromEntries(['questionId','topicId','seasonId'].filter(key=>params[key]).map(key=>[key,params[key]])):{})});
}
export function expressionScopeTitle(scope:LightScope){
  if(scope.type==='collection')return scope.id==='ielts'?'我的雅思表达':'我的对话表达';
  return scope.type==='question'?'本题表达':scope.type==='material'?'本次材料的表达':'全部个人表达';
}
