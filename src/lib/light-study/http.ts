import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { LightStudyError,type LightScope } from "./contracts";
import {expressionScope} from './scope-links';
export function scopeFromUrl(url:string):LightScope {
  const params=new URL(url).searchParams;
  const parsed=expressionScope({scope:'all',...Object.fromEntries(params)});
  if(!parsed.success)throw parsed.error;
  return parsed.data;
}
export function lightError(error:unknown) {
  if(error instanceof ZodError || error instanceof SyntaxError)return NextResponse.json({error:"请求格式不正确，请刷新后重试",code:"invalid_request"},{status:400});
  if(error instanceof LightStudyError)return NextResponse.json({error:error.message,code:error.code,current:error.current},{status:error.status});
  return NextResponse.json({error:"暂时无法保存或读取，当前内容没有被清空，请重试",code:"light_service_unavailable"},{status:503});
}
