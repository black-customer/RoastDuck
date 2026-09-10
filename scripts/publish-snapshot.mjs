/** Build a shareable working-tree snapshot, never copy .git or publish automatically. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=process.cwd(), destination=path.resolve(root,'.publish/github');
if(!fs.existsSync(path.join(root,'package.json'))||!destination.startsWith(root+path.sep))throw new Error('Run from the RoastDuck root');
const candidates=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const excluded=[], files=[], changes=[];
const excludedRoots=['materials/','Material/','data/','pipeline/agent-work/','pipeline/books/','pipeline/queue/','pipeline/reports/','pipeline/sources/','pipeline/golden/questions.json','pipeline/golden/sentences.json','pipeline/src/fill_domains_data.py','scripts/process-content-enrichment.ts','scripts/verify-web-v020.ts','scripts/apply-style-calibration.ts','scripts/verification-budget.mjs','.zcode/','.impeccable/review/','reviews/','comp/'];
const privateReports=/^docs\/(archive|evidence|reviews)\//;
const allowedRoots=['src/','db/','scripts/','tests/','pipeline/src/','pipeline/prompts/','pipeline/golden/','android/','mobile/','assets/desktop/','public/','.agents/','.github/','.impeccable/','docs/'];
const bannedFile=/(?:^|\/)(?:node_modules|\.git|\.next[^/]*|build|__pycache__|\.gradle|test-results|playwright-report)\/|(?:\.db(?:-wal|-shm|-journal)?|\.keystore|\.jks|\.pem|\.key|\.mp3|\.wav|\.opus|\.docx|\.pdf|\.gz|\.zip|\.pyc|\.log|\.tsbuildinfo)$|(?:^|\/)local\.properties$/i;
const secretPatterns=[/sk-[A-Za-z0-9_-]{24,}/,/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const isBinary=name=>/\.(png|ico|jpg|jpeg|webp|woff2?|ttf|jar)$/i.test(name);
function target(name){const result=path.resolve(destination,name);if(!result.startsWith(destination+path.sep)||name.split('/').includes('.git'))throw new Error('Invalid snapshot path');return result;}
function write(name,content){const out=target(name);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,content);files.push({path:name,sha256:createHash('sha256').update(content).digest('hex')});}
function redact(text){return text.replace(/C:\\\\Users\\\\[^\\\r\n"']+/g,'C:\\\\Users\\\\USER').replace(/C:\\Users\\[^\\\r\n"']+/g,'C:\\Users\\USER').replace(/C:\/Users\/[^/\s"')]+/g,'C:/Users/USER');}
fs.mkdirSync(destination,{recursive:true});
const manifestPath=target('PUBLIC_SNAPSHOT.json');
const previous=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')).files:[];
for(const name of candidates){
  const source=path.resolve(root,name);if(!source.startsWith(root+path.sep)||!fs.existsSync(source)||!fs.lstatSync(source).isFile())continue;
  const reason=excludedRoots.some(p=>name.startsWith(p))?'private-or-unlicensed-content':bannedFile.test(name)?'local-or-generated-artifact':/^\.env/.test(name)&&name!=='.env.example'?'credentials':!allowedRoots.some(p=>name.startsWith(p))&&name.includes('/')?'unreviewed-directory':null;
  if(reason){excluded.push({path:name,reason});continue;}
  if(privateReports.test(name)){
    excluded.push({path:name,reason:'local-evidence'});
    if(name.endsWith('.md'))write(name,'# Local evidence omitted\n\nThis historical evidence remains on the project owner’s computer. It is not distributed in the public snapshot and is not a current product contract.\n');
    continue;
  }
  let content=fs.readFileSync(source);
  if(!isBinary(name)){
    const text=content.toString('utf8');
    if(secretPatterns.some(p=>p.test(text)))throw new Error(`Potential credential; snapshot stopped: ${name}`);
    const clean=name==='scripts/publish-snapshot.mjs'?text:redact(text);if(clean!==text)changes.push(name);
    content=Buffer.from(clean);
  }
  write(name,content);
}
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const notice='\n\n## Public development snapshot\n\nThis repository is a work in progress, not a finished release. No project-wide open-source license has been selected or granted. Third-party licenses remain applicable.\n\nPrivate answers, conversations, databases, API keys, recordings, local evidence, and unlicensed teaching materials (including extracted/derived datasets) are not distributed. The owner’s original files and Git history remain local. Supply your own data and API keys; existing private learning materials are not included. Synthetic tests/demos are not real user answers.\n\nA fresh installation starts with an empty personal database, not the owner’s IELTS question bank. Use your own legally obtained materials and credentials; FreeTalk can generate materials from your own conversations. Historical content-pipeline datasets are intentionally not distributed. See docs/PROJECT_STATUS.md for the actual implemented and verified scope. CI remains enabled; an upload is not a claim of verified learning effectiveness.\n';
const readme=files.find(f=>f.path==='README.md');if(readme){files.splice(files.indexOf(readme),1);write('README.md',fs.readFileSync(target('README.md'),'utf8')+notice);}
// Remove only files generated by the previous manifest; originals and unknown files are untouched.
const kept=new Set(files.map(f=>f.path));let removed=0;
for(const old of previous??[])if(!kept.has(old.path)&&fs.existsSync(target(old.path))){fs.unlinkSync(target(old.path));removed++;}
const manifest={version:1,sourceCommit,createdAt:new Date().toISOString(),policy:'clean-history; private data and unlicensed source/derivative materials excluded; no project license granted',files,excludedCounts:excluded.reduce((a,f)=>{a[f.reason]=(a[f.reason]??0)+1;return a;},{}),sanitizedFiles:changes};
fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.resolve(root,'.publish/excluded.local.json'),JSON.stringify(excluded,null,2)+'\n');
console.log(JSON.stringify({destination,sourceCommit,included:files.length,excluded:manifest.excludedCounts,sanitized:changes,removedSnapshotCopies:removed},null,2));
