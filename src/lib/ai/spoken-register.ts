export const SPOKEN_REGISTER_VERSION='young-us-v1' as const;
export const SPOKEN_REGISTER_PROMPT='spoken_register.young_us.v1.md';
export async function spokenInstructions(load:(name:string)=>string|Promise<string>,base:string,profile?:string){
  const instructions=await load(base);
  if(!profile)return instructions;
  if(profile!==SPOKEN_REGISTER_VERSION)throw new Error('Unsupported spoken register version');
  return instructions+'\n\n'+await load(SPOKEN_REGISTER_PROMPT);
}
