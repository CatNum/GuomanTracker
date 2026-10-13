import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root=new URL('../../',import.meta.url);
const output=new URL('.cloudbase-deploy/',root);
// Only this generated, ignored directory is replaced. Source and local credentials stay outside it.
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for(const name of ['guoman-user','guoman-catalog','guoman-scan']) {
  const source=new URL(`cloudbase/functions/${name}/`,root),target=new URL(`${name}/`,output);
  await mkdir(target,{recursive:true});
  for(const file of await readdir(source)) {
    if(file==='node_modules'||file.startsWith('.'))continue;
    if(/\.(?:js|mjs)$/.test(file)) {
      const content=await readFile(new URL(file,source),'utf8');
      await writeFile(new URL(file,target),content.replaceAll('../../shared/','./shared/').replaceAll('../../seed/','./seed/'));
    }else if(['package.json','package-lock.json'].includes(file))await cp(new URL(file,source),new URL(file,target));
  }
  await cp(new URL('cloudbase/shared/',root),new URL('shared/',target),{recursive:true});
  const pkg=JSON.parse(await readFile(new URL('package.json',target),'utf8'));
  if(!pkg.dependencies?.['@cloudbase/node-sdk'])throw new Error(`${name} 缺少 CloudBase Node SDK`);
  for(const file of await readdir(target))if(/\.(?:js|mjs)$/.test(file)) {
    const content=await readFile(new URL(file,target),'utf8');
    for(const match of content.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      await readFile(new URL(match[1],new URL(file,target)));
    }
    if(content.includes('../../shared/')||content.includes('../../seed/'))throw new Error(`${name} 打包后仍依赖外部路径`);
  }
}
console.log('已生成并检查三个云函数部署包：'+fileURLToPath(output));
