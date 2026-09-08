import { NextResponse } from "next/server";
import { lightOverview } from "@/lib/light-study/service";
import { lightError,scopeFromUrl } from "@/lib/light-study/http";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  try{return NextResponse.json({overview:await lightOverview(scopeFromUrl(request.url))});}
  catch(error){return lightError(error);}
}
