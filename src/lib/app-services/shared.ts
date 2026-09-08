import {sha256Text} from "@/lib/platform/hash";
export const stableId=(prefix:string,...parts:string[])=>`${prefix}_${sha256Text(parts.join("|")).slice(0,24)}`;
export const normalizeKey=(text:string)=>text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g," ");
export function parseJson<T>(text:string,fallback:T):T{try{return JSON.parse(text) as T;}catch{return fallback;}}
export const credentialValue=(text:string)=>/\bsk-[A-Za-z0-9_-]{12,}\b|(?:password|passcode|api[_ -]?key|密码|验证码|支付密码)\s*[:=：]\s*\S{3,}/i.test(text);
export const sensitiveMemory=(text:string)=>credentialValue(text)||/\b(password|passcode|verification code|credit card|cvv)\b|密码|验证码|银行卡|精确住址|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
