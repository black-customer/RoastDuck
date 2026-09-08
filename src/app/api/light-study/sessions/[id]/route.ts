import { NextResponse } from "next/server";
import { getLightView } from "@/lib/light-study/service";
import { lightError } from "@/lib/light-study/http";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
  try{return NextResponse.json({session:await getLightView((await params).id)});}
  catch(error){return lightError(error);}
}
