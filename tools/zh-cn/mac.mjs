import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openArchive, rebuildArchive, fileHash, sha256 } from './archive.mjs';
import { identify, saveState, readState, assertHash, withLock } from './operations.mjs';
import plans from './plans.json' with { type: 'json' };

const asar = app => path.join(app, 'Contents/Resources/app.asar');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });

function bundleFingerprint(app) {
  // Detect app updates or manual modifications before exchanging complete bundles.
  const rows = [];
  function visit(folder, relative = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name), key = relative + name, stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) rows.push([key,'link',fs.readlinkSync(full)]);
      else if (stat.isDirectory()) visit(full, key + '/');
      else if (stat.isFile()) rows.push([key,stat.mode & 0o777,fileHash(full)]);
      else throw new Error('应用包包含不支持的特殊文件。');
    }
  }
  visit(app);
  return sha256(JSON.stringify(rows));
}

function verifyBundle(app, expected) {
  if (!expected || bundleFingerprint(app) !== expected) throw new Error('应用包已改变或备份损坏，禁止覆盖。');
}

export function macOperation(app, operation, { guard, log }) {
  const parent = path.dirname(app);
  const folder = path.join(parent, '.' + path.basename(app) + '.bruno-zh-backup');
  const original = path.join(folder, 'original.app');
  const patched = path.join(folder, 'patched.app');
  const stage = path.join(folder, 'staging.app');
  guard();
  return withLock(parent, () => {
    let state = readState(folder);
    // Recover the narrow interruption window between two same-volume renames.
    if (!fs.existsSync(app) && state && fs.existsSync(original)) {
      log('检测到中断的安装，正在恢复完整原版应用…');
      verifyBundle(original, state.originalBundle);
      fs.renameSync(original, app);
    }
    if (operation === 'restore') {
      if (!state) throw new Error('未找到汉化备份。');
      if (fileHash(asar(app)) === state.original) { verifyBundle(app,state.originalBundle); return '已是原版。'; }
      verifyBundle(app,state.patchedBundle); verifyBundle(original,state.originalBundle);
      if (fs.existsSync(patched)) throw new Error('恢复暂存位置已存在。请保留备份目录并检查上次操作。');
      guard();
      fs.renameSync(app, patched);
      try { fs.renameSync(original, app); } catch (e) { fs.renameSync(patched, app); throw e; }
      saveState(folder, { ...state, phase: 'restored' });
      return '已恢复完整原版应用及其原始签名。';
    }
    if (state && fileHash(asar(app)) === state.patched) {
      verifyBundle(app,state.patchedBundle); verifyBundle(original,state.originalBundle);
      return '已安装此汉化补丁。';
    }
    log('正在检查官方 Apple 芯片版及签名…');
    const build = identify(asar(app), 'darwin');
    if (state && state.original !== build.archiveSha256) throw new Error('备份与当前版本不一致。');
    const architecture = command('/usr/bin/lipo', ['-archs', path.join(app,'Contents/MacOS/Bruno')]).trim();
    if (architecture !== 'arm64') throw new Error('仅支持原生 Apple Silicon（arm64）版 Bruno。');
    command('/usr/bin/codesign', ['--verify','--deep','--strict',app]);
    fs.mkdirSync(folder, { recursive: true });
    log('正在校验完整应用，保留原始签名备份…');
    const originalBundle = bundleFingerprint(app);
    if (state) verifyBundle(app, state.originalBundle);
    if (fs.existsSync(original)) throw new Error('原版备份位置已有文件，请勿覆盖。');
    if (state && fs.existsSync(patched)) {
      verifyBundle(patched,state.patchedBundle);
    } else {
      if (fs.existsSync(stage)) {
        const marker = path.join(folder, 'stage-owner.json');
        if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker,'utf8')).source !== build.archiveSha256) {
          throw new Error('staging.app 已存在但无法确认归属，已停止。当前原版未修改。');
        }
        // Preserve interrupted output for inspection. Never recursively delete it.
        fs.renameSync(stage,path.join(folder,`interrupted-${Date.now()}.app`));
        log('已保留上次未完成的副本，重新生成…');
      }
      fs.writeFileSync(path.join(folder,'stage-owner.json'),JSON.stringify({source:build.archiveSha256}));
      log('正在创建中文应用副本（可能需要一分钟）…');
      command('/usr/bin/ditto', [app,stage]);
      const temporary = asar(stage) + '.zh-new';
      const headerHash = rebuildArchive(asar(stage), temporary, build.files);
      fs.renameSync(temporary, asar(stage));
      const plist = path.join(stage,'Contents/Info.plist');
      command('/usr/libexec/PlistBuddy', ['-c',`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,plist]);
      // Ad-hoc signatures have no Team ID. The main executable needs an explicit
      // library-validation exception to load the original signed Electron framework.
      // Keep hardened runtime and all original entitlements; do not re-sign nested code.
      const entitlements = command('/usr/bin/codesign',['--display','--entitlements',':-',app]);
      if (!entitlements.includes('<plist')) throw new Error('无法读取原应用权限，已停止签名。');
      const entitlementFile = path.join(folder,'local-entitlements.plist');
      fs.writeFileSync(entitlementFile,entitlements);
      const entitlementKey = 'com.apple.security.cs.disable-library-validation';
      command('/usr/libexec/PlistBuddy',['-c',`${entitlements.includes('<key>'+entitlementKey+'</key>')?'Set':'Add'} :${entitlementKey} ${entitlements.includes('<key>'+entitlementKey+'</key>')?'true':'bool true'}`,entitlementFile]);
      log('正在本机重新签名并验证中文副本…');
      command('/usr/bin/codesign', ['--force','--sign','-','--preserve-metadata=flags','--entitlements',entitlementFile,stage]);
      command('/usr/bin/codesign', ['--verify','--deep','--strict',stage]);
      const patchedHash = fileHash(asar(stage));
      const patchedBundle = bundleFingerprint(stage);
      state = { format:1, patchVersion:plans.patchVersion, platform:'darwin', original:build.archiveSha256, patched:patchedHash, originalBundle, patchedBundle, phase:'prepared' };
      saveState(folder,state);
      fs.renameSync(stage,patched);
    }
    guard(); verifyBundle(app,originalBundle);
    log('正在切换应用，原版完整保留…');
    fs.renameSync(app,original);
    try { fs.renameSync(patched,app); } catch(e) { fs.renameSync(original,app); throw e; }
    saveState(folder,{...state,phase:'applied'});
    return '汉化完成。完整原版及签名已保留；本机签名副本替代当前应用。';
  });
}

export const macInternals = { bundleFingerprint };
