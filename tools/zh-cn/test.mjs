import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openArchive, rebuildArchive, fileHash, sha256, applyEdits } from './archive.mjs';
import { windowsOperation, withLock, identify } from './operations.mjs';
import plans from './plans.json' with { type: 'json' };

const root = fs.mkdtempSync(path.join(process.env.BRUNO_TEST_TMP || os.tmpdir(),'bruno-zh-tests-'));
function fixture(file,version='4.2.1') {
  const sources = { 'package.json':JSON.stringify({name:'bruno',version}), 'ui.js':'const ui={children:"Save"}; const payload={name:"Save",value:"Send"};', 'data.json':'{"Name":"Name","message":"Create Collection","url":"https://example.com/Save"}' };
  let offset = 0;
  const files = {};
  for (const [key,value] of Object.entries(sources)) {
    files[key]={offset:String(offset),size:Buffer.byteLength(value)};
    offset+=Buffer.byteLength(value);
  }
  files['native.node']={size:10,unpacked:true};
  files.alias={link:'data.json'};
  const header=Buffer.from(JSON.stringify({files}));
  const prefix=Buffer.alloc(16+Math.ceil(header.length/4)*4);
  prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(prefix.length-8,4);prefix.writeUInt32LE(prefix.length-12,8);prefix.writeUInt32LE(header.length,12);header.copy(prefix,16);
  fs.writeFileSync(file,Buffer.concat([prefix,...Object.values(sources).map(s=>Buffer.from(s))]));
  return sources;
}

test('ASAR: preserves payload, unpacked metadata and links; updates integrity',()=>{
  const input=path.join(root,'original.asar'),output=path.join(root,'patched.asar');
  const sources=fixture(input),start=sources['ui.js'].indexOf('"Save"');
  const translated=sources['ui.js'].replace('children:"Save"','children:"保存"');
  const plan={path:'ui.js',before:sha256(sources['ui.js']),after:sha256(translated),edits:[[start,start+6,'"Save"','"保存"']]};
  const headerHash=rebuildArchive(input,output,[plan]);
  const original=openArchive(input),patched=openArchive(output);
  try {
    assert.equal(patched.read('ui.js').toString(),translated);
    assert.match(patched.read('ui.js').toString(),/name:"Save",value:"Send"/);
    assert.deepEqual(patched.read('data.json'),original.read('data.json'));
    assert.deepEqual(patched.entries.get('native.node'),original.entries.get('native.node'));
    assert.deepEqual(patched.entries.get('alias'),original.entries.get('alias'));
    assert.equal(patched.entries.get('ui.js').integrity.hash,sha256(translated));
    assert.equal(headerHash,sha256(patched.headerText));
    assert.throws(()=>patched.read('native.node'),/缺少/);
  } finally { original.close();patched.close(); }
});
test('ASAR: refuses corrupt/truncated headers and missing edit preconditions',()=>{
  const file=path.join(root,'bad.asar');fs.writeFileSync(file,Buffer.alloc(20));
  assert.throws(()=>openArchive(file),/ASAR/);
  assert.throws(()=>applyEdits(Buffer.from('abc'),{path:'test',before:sha256('abc'),after:'',edits:[[0,2,'xx','中']]}),/位置/);
  assert.throws(()=>applyEdits(Buffer.from('abc'),{path:'test',before:'wrong',edits:[]}),/校验/);
});
test('identity: rejects other versions before mutation',()=>{
  const file=path.join(root,'other.asar');fixture(file,'4.2.0');const before=fileHash(file);
  assert.throws(()=>identify(file,'win32'),/仅支持/);assert.equal(fileHash(file),before);
});
test('lock: excludes concurrent writers; refuses stale/incomplete records without deleting them',()=>{
  withLock(root,()=>assert.throws(()=>withLock(root,()=>assert.fail()),/锁已存在/));
  const lock=path.join(root,'.bruno-zh.lock');assert.equal(fs.existsSync(lock),false);
  fs.writeFileSync(lock,'');assert.throws(()=>withLock(root,()=>assert.fail()),/锁已存在/);
  assert.equal(fs.readFileSync(lock,'utf8'),'');fs.unlinkSync(lock);
  assert.throws(()=>withLock(root,()=>{throw new Error('intentional');}),/intentional/);
  assert.equal(fs.existsSync(lock),false);
});

if (process.env.BRUNO_TEST_APP) test('official Windows archive: apply/restore/idempotency/corruption/update guards',()=>{
  const app=path.resolve(process.env.BRUNO_TEST_APP);
  // Never run this integration suite against Program Files or an arbitrary installation.
  assert.match(app.replaceAll('\\','/'),/\/work\/bruno-test$/);
  const live=path.join(app,'resources/app.asar');
  const original=path.join(app,'resources/bruno-zh-backup/original.asar');
  const before=plans.builds.find(b=>b.platform==='win32').archiveSha256;
  windowsOperation(app,'restore');assert.equal(fileHash(live),before);
  const blockedHash=fileHash(live);
  assert.throws(()=>windowsOperation(app,'apply',{guard:()=>{throw new Error('still running');}}),/still running/);
  assert.equal(fileHash(live),blockedHash);
  windowsOperation(app,'apply');const patchedHash=fileHash(live);
  assert.notEqual(patchedHash,before);assert.equal(fileHash(original),before);
  assert.match(windowsOperation(app,'apply'),/无需重复/);assert.equal(fileHash(live),patchedHash);
  function flip(file) { const fd=fs.openSync(file,'r+'),at=fs.fstatSync(fd).size-1,b=Buffer.alloc(1);fs.readSync(fd,b,0,1,at);b[0]^=1;fs.writeSync(fd,b,0,1,at);fs.closeSync(fd); }
  flip(original);
  try { assert.throws(()=>windowsOperation(app,'restore'),/备份.*校验失败/);assert.equal(fileHash(live),patchedHash); }
  finally {flip(original);}
  flip(live);
  try { assert.throws(()=>windowsOperation(app,'restore'),/升级或被修改/); }
  finally {flip(live);}
  windowsOperation(app,'restore');assert.equal(fileHash(live),before);
  assert.match(windowsOperation(app,'restore'),/无需恢复/);
  windowsOperation(app,'apply');assert.equal(fileHash(live),patchedHash);
});

if (process.env.BRUNO_MAC_ASAR) test('official macOS arm64 archive: patch and verify every packed entry',()=>{
  const input=path.resolve(process.env.BRUNO_MAC_ASAR),output=path.join(root,'mac-patched.asar');
  const build=identify(input,'darwin');rebuildArchive(input,output,build.files);
  const original=openArchive(input),patched=openArchive(output),changes=new Map(build.files.map(f=>[f.path,f.after]));
  try {
    for (const [name,entry] of original.entries) {
      if (entry.unpacked||entry.link) assert.deepEqual(patched.entries.get(name),entry);
      else assert.equal(sha256(patched.read(name)),changes.get(name)||sha256(original.read(name)),name);
    }
  } finally {original.close();patched.close();}
});
