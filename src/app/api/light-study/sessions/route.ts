import { NextResponse } from "next/server";
import { createLightSession } from "@/lib/light-study/service";
import { lightError } from "@/lib/light-study/http";
export async function POST(request:Request) {
  try{return NextResponse.json({session:await createLightSession(await request.json())});}
  catch(error){return lightError(error);}
}
