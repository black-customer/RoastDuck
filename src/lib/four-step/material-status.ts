/** 仅使用安全错误代码；不把 Provider 原始响应、私密上下文或堆栈下发客户端。 */
export function materialFailureMessage(code:string|null|undefined){
  if(code?.includes("timeout"))return "AI 在返回分析结果前超时。你的回答已保存，重试会继续尚未完成的阶段。";
  if(code?.includes("invalid_output")||code?.includes("incomplete_output"))return "AI 返回的分析格式不完整，未能生成训练材料。原回答未丢失，可以重新处理。";
  if(code?.includes("source_quote")||code?.includes("source_coverage"))return "分析中的原文引用或覆盖不完整，材料未发布。需要重新核对原回答，不能直接当作学习材料。";
  if(code?.includes("rejected"))return "独立核对发现材料不符合原意或训练要求，已保留原回答，需要修正材料后再学习。";
  if(code?.includes("balance"))return "AI 账户余额不足，本次分析未完成。原回答已保留。";
  if(code?.includes("authentication")||code?.includes("configuration"))return "AI 服务配置不可用，请在设置中检查；原回答已经保存。";
  return "材料还没有完成处理。原回答已经保存，当前不能开始强化，也不会记为已学会。";
}
