import type { LightMode, LightOverview, LightScope } from "../light-study/contracts";
export type HomeLightAction = {kind:"question";label:string}|{kind:"resume"|"review"|"learn";label:string;scope:LightScope;mode:LightMode};
export function chooseHomeLightAction(overview:Pick<LightOverview,"enabled"|"dueCount"|"newCount">,latest:{scope:LightScope;mode:LightMode}|null):HomeLightAction {
  if(latest)return {kind:"resume",label:"继续上次学习",...latest};
  if(overview.enabled&&overview.dueCount>0)return {kind:"review",label:"复习到期表达",scope:{type:"all"},mode:"review"};
  if(overview.enabled&&overview.newCount>0)return {kind:"learn",label:"学几个新表达",scope:{type:"all"},mode:"learn"};
  return {kind:"question",label:"回答一道题，生成我的材料"};
}
