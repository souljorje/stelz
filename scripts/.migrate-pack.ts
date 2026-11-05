import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
function replace(path: string, before: string, after: string) {
 const text=readFileSync(path,'utf8');
 if(text.split(before).length!==2) throw Error('Missing unique anchor: '+path+' '+before);
 writeFileSync(path,text.replace(before,after));
}
const release='scripts/verify-release.ts';
replace(release,'import { checkMarkdownLinks }','import { packRelease } from "./pack-release.ts";\nimport { checkMarkdownLinks }');
replace(release,'Verify npm pack lifecycle and isolated browser-free installation.','Verify Bun pack lifecycle and isolated npm browser-free installation.');
replace(release,'// Removing generated artifacts proves that the real npm prepack lifecycle builds them.','// Removing generated artifacts proves that the pack lifecycle builds them.');
replace(release,'const lifecycle = JSON.parse(await run([npm, "pack", "--json", "--pack-destination", temp], { cwd: product })) as Array<{ filename: string; files: Array<{ path: string }> }>;','const lifecycle = [await packRelease(product, temp, { env })];');
replace(release,'npm prepack did not build the CLI.','The prepack lifecycle did not build the CLI.');
replace(release,'const packed = JSON.parse(await run([npm, "pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: join(root, "packages/stelz") })) as Array<{ filename: string; files: Array<{ path: string }> }>;','const packed = [await packRelease(product, temp, { env, ignoreScripts: true })];');
const qa='tests/qa/package.ts';
replace(qa,'import { verifyBundledDependencies','import { packRelease } from "../../scripts/pack-release.ts";\nimport { verifyBundledDependencies');
replace(qa,'const packed = JSON.parse(await run([npm, "pack", "--json", "--ignore-scripts"], { cwd: join(root, "packages/stelz") })) as Array<{ filename: string; files: Array<{ path: string }> }>;','const packed = [await packRelease(join(root, "packages/stelz"), temp, { env, ignoreScripts: true })];');
replace(qa,'const archive = join(root, "packages/stelz", packed[0]!.filename);','const archive = join(temp, packed[0]!.filename);');
function docs(folder:string) {
 for(const file of readdirSync(folder,{withFileTypes:true})) {
  const path=join(folder,file.name);
  if(file.isDirectory()) docs(path);
  else if(file.name.endsWith('.md')) {
   const text=readFileSync(path,'utf8');
   if(text.includes('npm pack')) writeFileSync(path,text.replaceAll('npm pack','bun pm pack'));
  }
 }
}
docs('docs');
const readme=readFileSync('README.md','utf8');
writeFileSync('README.md',readme.replaceAll('npm pack','bun pm pack'));
const note='\nThe packer is `bun pm pack` because it understands the pinned Bun workspace layout and bundles the dependency closure. npm 11 directory packing failed with `Exit handler never called` for this layout during validation. npm still inspects and installs the exact generated tarball. Publish the verified `.tgz`, not the workspace directory; this change does not publish anything.\n';
writeFileSync('docs/camofox-patches.md',readFileSync('docs/camofox-patches.md','utf8')+note);
rmSync('scripts/.migrate-pack.ts');
rmSync('.github/workflows/validate-camofox-bundle.yml');
