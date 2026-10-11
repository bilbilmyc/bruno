import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env,BRUNO_TEST_TMP:path.join(root,'work')};
if(process.platform==='darwin'){
  const app=path.resolve(env.BRUNO_TEST_APP);
  env.BRUNO_MAC_ASAR=path.join(path.dirname(app),'.'+path.basename(app)+'.bruno-zh-backup/original.app/Contents/Resources/app.asar');
  delete env.BRUNO_TEST_APP;
}
execFileSync(process.execPath,['--test',path.join(root,'test.mjs')],{env,stdio:'inherit'});
