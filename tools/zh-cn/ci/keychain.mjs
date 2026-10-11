// Disposable GitHub runner fixture only. Never change a developer's keychain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const security = args => execFileSync('/usr/bin/security',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const storageKey=crypto.randomBytes(16).toString('base64');
export function withSmokeKeychain(root, app, phase, callback) {
  if(process.platform!=='darwin') return callback();
  if(process.env.GITHUB_ACTIONS!=='true') throw new Error('Mac smoke keychains are restricted to disposable GitHub runners');
  const keychain=path.join(root,'work','smoke-'+phase+'.keychain-db');
  if(fs.existsSync(keychain)) throw new Error('Test keychain already exists');
  const password=crypto.randomBytes(24).toString('hex');
  const originalDefault=security(['default-keychain','-d','user']).trim().replace(/^"|"$/g,'');
  const originalSearch=[...security(['list-keychains','-d','user']).matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  security(['create-keychain','-p',password,keychain]);
  try {
    security(['unlock-keychain','-p',password,keychain]);
    security(['set-keychain-settings','-lut','3600',keychain]);
    security(['list-keychains','-d','user','-s',keychain]);
    security(['default-keychain','-d','user','-s',keychain]);
    // Same synthetic key, explicit trust for the current binary's signature.
    // This models a user granting access after re-signing without accepting UI prompts.
    security(['add-generic-password','-a','bruno','-s','bruno Safe Storage','-w',storageKey,'-T',path.join(app,'Contents/MacOS/Bruno'),keychain]);
    return callback();
  } finally {
    security(['default-keychain','-d','user','-s',originalDefault]);
    security(['list-keychains','-d','user','-s',...originalSearch]);
    security(['lock-keychain',keychain]);
  }
}
