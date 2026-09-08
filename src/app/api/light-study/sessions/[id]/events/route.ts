import { NextResponse } from "next/server";
import { applyLightEvent } from "@/lib/light-study/service";
import { lightError } from "@/lib/light-study/http";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
  try{return NextResponse.json({session:await applyLightEvent((await params).id,await request.json())});}
  catch(error){return lightError(error);}
}
