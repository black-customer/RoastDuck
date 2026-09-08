"use client";
import Link from "next/link";
import {LightStudyPanel} from "./LightStudyPanel";
import {webLightClient} from "@/lib/light-study/web-client";
import type {LightScope} from "@/lib/light-study/contracts";
export function LightStudy(props:{scope:LightScope;initialSessionId?:string;initialError?:string;initialMode?:'learn'|'review'}){
  return <LightStudyPanel {...props} client={webLightClient} Link={Link}/>;
}
