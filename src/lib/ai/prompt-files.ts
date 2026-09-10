import fs from 'node:fs';
import path from 'node:path';
/** Production releases freeze their prompts together with the matching schemas. */
export function readPrompt(filename:string){
  if(path.basename(filename)!==filename||!filename.endsWith('.md'))throw new Error('Invalid prompt filename');
  return fs.readFileSync(path.join(process.env.ROASTDUCK_PROMPT_ROOT||path.join(process.cwd(),'pipeline','prompts'),filename),'utf8');
}
