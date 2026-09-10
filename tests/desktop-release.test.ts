import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {activeRelease,activateRelease,releaseDirectory,fingerprintSources} from '../scripts/desktop/releases.mjs';

const roots:string[]=[];
function fixture(){
  const parent=path.resolve('test-results');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'desktop-release-'));roots.push(root);return root;
}
function build(root:string,releaseId:string){
  const directory=releaseDirectory(root,releaseId);fs.mkdirSync(path.join(directory,'server'),{recursive:true});
  fs.mkdirSync(path.join(directory,'runtime-prompts'),{recursive:true});
  fs.writeFileSync(path.join(directory,'BUILD_ID'),releaseId);
  for(const file of ['routes-manifest.json','required-server-files.json','server/pages-manifest.json','server/app-paths-manifest.json'])fs.writeFileSync(path.join(directory,file),'{}');
  return {version:1,releaseId,buildId:releaseId};
}
afterEach(()=>{
  for(const root of roots.splice(0)){
    if(!root.startsWith(path.resolve('test-results')+path.sep))throw new Error('unsafe test cleanup');
    fs.rmSync(root,{recursive:true,force:true});
  }
});
describe('desktop production release',()=>{
  it('隔离构建的路径别名相对项目根，而不是生成的tsconfig目录',()=>{
    const script=fs.readFileSync(path.resolve('scripts/desktop/build-release.mjs'),'utf8');
    expect(script).toContain('baseUrl:root');
  });
  it('不完整构建不能替换当前版本；成功激活保留上一个版本与文件',()=>{
    const root=fixture(),old=build(root,'old-1');activateRelease(root,old);
    const newer=build(root,'new-2');fs.unlinkSync(path.join(releaseDirectory(root,'new-2'),'BUILD_ID'));
    expect(()=>activateRelease(root,newer)).toThrow();expect(activeRelease(root).releaseId).toBe('old-1');
    fs.writeFileSync(path.join(releaseDirectory(root,'new-2'),'BUILD_ID'),'new-2');
    activateRelease(root,newer);
    expect(activeRelease(root)).toMatchObject({releaseId:'new-2',previousReleaseId:'old-1'});
    expect(fs.existsSync(path.join(releaseDirectory(root,'old-1'),'BUILD_ID'))).toBe(true);
  });
  it('没有已构建版本明确失败，不回到开发服务器；路径不能逃逸',()=>{
    const root=fixture();expect(()=>activeRelease(root)).toThrow('build-release.mjs');
    for(const id of ['../data','a/b','a\\b','','C:\\temp'])expect(()=>releaseDirectory(root,id)).toThrow();
  });
  it('构建指纹覆盖源码与Prompt变化，环境值和学习数据库不进入清单',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'pipeline/prompts'),{recursive:true});
    fs.writeFileSync(path.join(root,'src/app.ts'),'first');fs.writeFileSync(path.join(root,'pipeline/prompts/test.md'),'prompt');
    const files=['src/app.ts','pipeline/prompts/test.md','.env.local','data/app.db'];
    const original=fingerprintSources(root,files);
    fs.writeFileSync(path.join(root,'.env.local'),'PRIVATE=changed');expect(fingerprintSources(root,files)).toBe(original);
    fs.writeFileSync(path.join(root,'pipeline/prompts/test.md'),'updated');expect(fingerprintSources(root,files)).not.toBe(original);
  });
});
