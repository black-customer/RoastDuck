import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const RELEASE_ID=/^[a-z0-9][a-z0-9-]{0,95}$/;

export function releaseDirectory(root,id){
  if(!RELEASE_ID.test(id??''))throw new Error('桌面版本编号无效');
  return path.join(root,'.next-desktop','releases',id);
}

export function validateRelease(root,manifest){
  if(!manifest||manifest.version!==1)throw new Error('桌面版本记录损坏，请重新构建');
  const directory=releaseDirectory(root,manifest.releaseId);
  const buildId=fs.readFileSync(path.join(directory,'BUILD_ID'),'utf8').trim();
  if(!buildId||buildId!==manifest.buildId)throw new Error('桌面版本不完整，请重新构建；原有版本已保留');
  for(const file of ['routes-manifest.json','required-server-files.json','server/pages-manifest.json','server/app-paths-manifest.json']){
    JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
  }
  if(!fs.statSync(path.join(directory,'runtime-prompts')).isDirectory())throw new Error('桌面版本缺少固定的 Prompt 合同');
  return {...manifest,directory,distDir:path.relative(root,directory).split(path.sep).join('/')};
}

export function activeRelease(root){
  const file=path.join(root,'data','desktop','release.json');
  if(!fs.existsSync(file))throw new Error('还没有桌面生产版本。请开发者先执行 node scripts/desktop/build-release.mjs；日常打开不会自动构建。');
  return validateRelease(root,JSON.parse(fs.readFileSync(file,'utf8')));
}

/** The active pointer only changes after a successful build and manifest validation. */
export function activateRelease(root,manifest){
  validateRelease(root,manifest);
  const directory=path.join(root,'data','desktop');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'release.json');
  const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  const next={...manifest,previousReleaseId:previous?.releaseId??null};
  const staged=path.join(directory,`release-${randomUUID()}.tmp`);
  fs.writeFileSync(staged,JSON.stringify(next,null,2),{flag:'wx'});
  fs.renameSync(staged,file);
  return next;
}

/** Only paths returned by git ls-files are fingerprinted; no environment values. */
export function fingerprintSources(root,files){
  const relevant=files.filter(file=>/^(src\/|db\/|pipeline\/prompts\/|public\/|package(?:-lock)?\.json$|(?:next|postcss|tailwind)\.config\.|tsconfig\.json$)/.test(file)).sort();
  const hash=createHash('sha256');
  for(const file of relevant){
    hash.update(file);hash.update('\0');
    const target=path.resolve(root,file);
    if(!target.startsWith(path.resolve(root)+path.sep))throw new Error('构建文件路径超出项目');
    if(fs.existsSync(target))hash.update(fs.readFileSync(target));else hash.update('<removed>');
    hash.update('\0');
  }
  return hash.digest('hex');
}
