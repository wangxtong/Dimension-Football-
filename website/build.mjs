import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [output]=process.argv.slice(2);
if(!output||process.argv.length!==3)throw Error('Usage: node website/build.mjs OUTPUT_DIRECTORY');
const assets={};for(const name of ['index.html','style.css','app.mjs','report-schema.mjs','locale-zh.mjs','evaluation-evidence.json','model-experiment-evidence.json','research-daily.html','research-daily-client.mjs'])assets['/'+name]=await readFile(new URL(name,import.meta.url),'utf8');
// The deployed Worker is one self-contained ESM file; browser assets stay separate.
const namespaces=new Map(),bundled=[];
function inlineImports(source) {
  return source.replace(/^import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm,(_,binding,path)=>{
    const namespace=namespaces.get(path);if(!namespace)throw Error('Unbundled Worker dependency: '+path);
    if(binding.startsWith('* as '))return `const ${binding.slice(5).trim()}=${namespace};`;
    if(!binding.trim().startsWith('{'))throw Error('Unsupported Worker import');
    return `const ${binding.replace(/\s+as\s+/g,': ')}=${namespace};`;
  });
}
for(const name of ['report-schema','market-observation-schema','locale-zh','github-oidc','state-archive','release-policy','hosted-publications','research-daily-store','telegram-presentation','hosted-notifications','daily-observation-notifications','system-heartbeat','telegram-bot','report-feed']) {
  const text=await readFile(new URL(name+'.mjs',import.meta.url),'utf8');
  const exported=[...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m=>m[1]);
  const body=inlineImports(text).replace(/^export\s+/gm,'');
  if(/^import\s/m.test(body)||exported.length===0)throw Error('Invalid Worker module: '+name);
  const namespace='__module_'+name.replaceAll('-','_');
  bundled.push(`const ${namespace}=(()=>{${body}\nreturn {${exported.join(',')}};})();`);
  namespaces.set('./'+name+'.mjs',namespace);
}
const source=bundled.join('\n')+'\n'+inlineImports(await readFile(new URL('worker.mjs',import.meta.url),'utf8'));
const manifest=JSON.parse(await readFile(new URL('.openai/hosting.json',import.meta.url),'utf8'));
if(manifest.static||!manifest.project_id)throw Error('Worker hosting manifest required');
await mkdir(resolve(output,'server'),{recursive:true});await mkdir(resolve(output,'.openai'),{recursive:true});
await writeFile(resolve(output,'server/index.js'),'const EMBEDDED_ASSETS = '+JSON.stringify(assets)+';\n'+source);
await writeFile(resolve(output,'.openai/hosting.json'),JSON.stringify(manifest,null,2)+'\n');
const worker=await import('data:text/javascript;base64,'+Buffer.from('const EMBEDDED_ASSETS = '+JSON.stringify(assets)+';\n'+source).toString('base64'));
if(typeof worker.default?.fetch!=='function')throw Error('Invalid Worker export');
console.log('Built and validated password-protected Worker');
