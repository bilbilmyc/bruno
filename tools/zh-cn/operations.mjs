import fs from 'node:fs';
import path from 'node:path';
import { openArchive, fileHash, rebuildArchive } from './archive.mjs';
import { randomUUID } from 'node:crypto';
import plans from './plans.json' with { type: 'json' };

export function identify(archivePath, platform) {
  const archive = openArchive(archivePath);
  try {
    const pkg = JSON.parse(archive.read('package.json'));
    if (pkg.name !== 'bruno' || pkg.version !== plans.brunoVersion) throw new Error('此补丁仅支持官方 Bruno 4.2.1，请勿用于其他版本。');
  } finally { archive.close(); }
  const hash = fileHash(archivePath);
  const build = plans.builds.find(b => b.platform === platform && b.archiveSha256 === hash);
  if (!build) throw new Error('安装包校验不匹配：文件可能已修改，或不属于本补丁支持的官方构建。已停止。');
  return build;
}

export function saveState(folder, state) {
  const temporary = path.join(folder, 'state.next.json');
  const fd = fs.openSync(temporary, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, path.join(folder, 'state.json'));
}

export function readState(folder) {
  const file = path.join(folder, 'state.json');
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.format !== 1 || !/^[a-f0-9]{64}$/.test(state.original || '') || !/^[a-f0-9]{64}$/.test(state.patched || '')) {
    throw new Error('备份记录损坏。请保留整个备份文件夹，勿手动覆盖安装文件。');
  }
  if (!plans.builds.some(b => b.archiveSha256 === state.original)) throw new Error('备份不属于此补丁支持的版本。');
  return state;
}

export function assertHash(file, expected, description) {
  if (!fs.existsSync(file) || fileHash(file) !== expected) throw new Error(`${description}校验失败，已停止，未覆盖文件。`);
}

export function withLock(folder, action) {
  const lock = path.join(folder, '.bruno-zh.lock');
  // Never reclaim locks automatically: two stale-lock reclaimers can otherwise
  // delete a newly acquired live lock. Recovery is an explicit offline procedure.
  if (fs.existsSync(lock)) {
    throw new Error(`操作锁已存在。请关闭所有补丁窗口；若上次异常中断，按说明删除锁文件后重试：${lock}`);
  }
  const pending = lock + '.' + randomUUID();
  const fd = fs.openSync(pending, 'wx');
  try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.linkSync(pending, lock); } finally { fs.unlinkSync(pending); }
  try { return action(); } finally { fs.unlinkSync(lock); }
}

export function windowsOperation(app, operation, { guard = () => {}, log = () => {} } = {}) {
  const resources = path.join(app, 'resources');
  const live = path.join(resources, 'app.asar');
  const backup = path.join(resources, 'bruno-zh-backup');
  const original = path.join(backup, 'original.asar');
  const stage = path.join(backup, 'staging.asar');
  guard();
  return withLock(resources, () => {
    let state = readState(backup);
    if (operation === 'restore') {
      if (!state) throw new Error('未找到汉化备份，无需恢复。');
      assertHash(original, state.original, '原版备份');
      const current = fileHash(live);
      if (current === state.original) return '已是原版，无需恢复。';
      if (current !== state.patched) throw new Error('Bruno 已升级或被修改，禁止用旧备份覆盖。');
      log('正在准备原版文件…');
      fs.copyFileSync(original, stage);
      assertHash(stage, state.original, '恢复副本');
      guard(); assertHash(live, state.patched, '当前安装');
      fs.renameSync(stage, live);
      assertHash(live, state.original, '恢复结果');
      saveState(backup, { ...state, phase: 'restored' });
      return '已恢复原版，SHA-256 与汉化前完全一致。';
    }
    if (state && fileHash(live) === state.patched) {
      assertHash(original, state.original, '原版备份');
      return '已安装此汉化补丁，无需重复应用。';
    }
    log('正在检查版本及原始文件…');
    const build = identify(live, 'win32');
    if (state && state.original !== build.archiveSha256) throw new Error('备份与当前版本不一致，请保留旧备份。');
    fs.mkdirSync(backup, { recursive: true });
    if (fs.existsSync(original)) assertHash(original, build.archiveSha256, '原版备份');
    else {
      log('正在备份原版…');
      // Partial copies use a separate name; a failed copy never becomes the trusted backup.
      const pending = path.join(backup, 'original.pending');
      fs.copyFileSync(live, pending);
      assertHash(pending, build.archiveSha256, '原版备份');
      fs.renameSync(pending, original);
    }
    if (fs.existsSync(stage)) fs.unlinkSync(stage);
    log('正在生成并校验中文资源…');
    rebuildArchive(original, stage, build.files);
    const patched = fileHash(stage);
    state = { format: 1, patchVersion: plans.patchVersion, platform: 'win32', original: build.archiveSha256, patched, phase: 'prepared' };
    saveState(backup, state);
    guard(); assertHash(live, state.original, '当前安装');
    fs.renameSync(stage, live);
    assertHash(live, state.patched, '汉化结果');
    saveState(backup, { ...state, phase: 'applied' });
    return `汉化完成。替换 ${build.files.reduce((n,f)=>n+f.edits.length,0)} 处静态界面文案及菜单项，原版已备份。`;
  });
}
