import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { windowsOperation, readState, identify } from './operations.mjs';
import { macOperation } from './mac.mjs';
import { fileHash } from './archive.mjs';
import plans from './plans.json' with { type: 'json' };

function run(program,args) { return execFileSync(program,args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}); }
function guard() {
  if (process.platform === 'win32') {
    const output = run('tasklist.exe',['/FI','IMAGENAME eq Bruno.exe','/FO','CSV','/NH']);
    if (/"Bruno\.exe"/i.test(output)) throw new Error('请先保存工作并完全退出 Bruno，再运行补丁。程序不会强制结束你的进程。');
  } else {
    const processes = run('/bin/ps',['-axo','comm=']);
    if (processes.split('\n').some(line=>/\/Bruno\.app\/Contents\//.test(line)||/\/Contents\/MacOS\/Bruno$/.test(line))) {
      throw new Error('请先保存工作并用 ⌘Q 完全退出 Bruno，再运行补丁。');
    }
  }
}

function detect() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Bruno.app',path.join(os.homedir(),'Applications/Bruno.app')]
    : [process.env.ProgramFiles && path.join(process.env.ProgramFiles,'Bruno'),process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Programs','bruno')];
  const found = candidates.filter(Boolean).filter(p=>fs.existsSync(p));
  if (found.length !== 1) throw new Error('未找到唯一的 Bruno 安装目录，请用 --app 指定 Bruno 文件夹或 Bruno.app。');
  return found[0];
}

function checkWindowsFuse(app) {
  const data = fs.readFileSync(path.join(app,'Bruno.exe'));
  const marker = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const i = data.indexOf(marker);
  if (i < 0 || data[i+marker.length] !== 1) throw new Error('无法校验 Electron 构建标志，已停止。');
  const count = data[i+marker.length+1];
  if (count <= 4 || data[i+marker.length+2+4] !== 48) throw new Error('此构建启用了嵌入式 ASAR 强校验，不属于受支持安装包。');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Bruno ${plans.brunoVersion} 简体中文补丁 ${plans.patchVersion}\n用法：bruno-zh [apply|restore|status] [--app 安装目录]\n不指定操作时显示交互菜单。Windows x64 / macOS Apple Silicon。\n完全离线运行。先退出 Bruno。汉化及恢复不会修改集合、凭据或用户配置。`);
    return;
  }
  if (!['win32','darwin'].includes(process.platform)) throw new Error('仅支持 Windows 和 macOS。');
  if (process.platform === 'darwin' && process.arch !== 'arm64') throw new Error('Mac 版仅支持 Apple Silicon。');
  let operation, appArgument;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--app') { appArgument = args[++i]; if (!appArgument) throw new Error('--app 后需提供路径。'); }
    else if (['apply','restore','status'].includes(args[i]) && !operation) operation=args[i];
    else throw new Error('未知参数：'+args[i]);
  }
  const interactive = !operation;
  const readline = interactive ? createInterface({ input:process.stdin,output:process.stdout }) : null;
  try {
    if (interactive) {
      console.log(`Bruno ${plans.brunoVersion} 简体中文补丁\n1. 安装汉化\n2. 恢复原版\n3. 检查状态\n0. 退出`);
      const answer = (await readline.question('请选择 [1/2/3/0]：')).trim();
      if (answer==='0') return;
      operation = {'1':'apply','2':'restore','3':'status'}[answer];
      if (!operation) throw new Error('未选择有效操作。');
    }
    const app = path.resolve(appArgument || detect());
    const mac = process.platform === 'darwin';
    const backup = mac ? path.join(path.dirname(app),'.'+path.basename(app)+'.bruno-zh-backup') : path.join(app,'resources/bruno-zh-backup');
    const archive = path.join(app,mac?'Contents/Resources/app.asar':'resources/app.asar');
    if (mac && !app.endsWith('.app')) throw new Error('请指定 Bruno.app 应用路径。');
    if (!mac && !fs.existsSync(path.join(app,'Bruno.exe'))) throw new Error('目录中未找到 Bruno.exe。');
    if (operation==='status') {
      const state = readState(backup);
      if (!fs.existsSync(archive)) throw new Error('应用文件缺失；若上次 Mac 切换中断，请执行 restore --app 原应用路径。');
      const hash=fileHash(archive);
      if (state && hash===state.patched) console.log(`状态：已汉化（Bruno ${plans.brunoVersion}）。`);
      else { identify(archive,process.platform);console.log(`状态：原版 Bruno ${plans.brunoVersion}，可安装此补丁。`); }
      return;
    }
    guard();
    if (!mac) checkWindowsFuse(app);
    const started=Date.now();
    const log=message=>console.log(`[${Math.round((Date.now()-started)/1000)} 秒] ${message}`);
    console.log('目标：'+app);
    console.log((mac?macOperation:windowsOperation)(app,operation,{guard,log}));
    console.log(`操作结束，用时 ${Math.round((Date.now()-started)/1000)} 秒。可以重新打开 Bruno。`);
  } catch(error) {
    if (!interactive) throw error;
    reportError(error);
  } finally {
    if (readline) { await readline.question('按 Enter 关闭窗口…');readline.close(); }
  }
}

function reportError(error) {
  const message = ['EACCES','EPERM'].includes(error.code) ? '没有写入权限。Windows 请右键以管理员身份运行；Mac 请按说明使用 sudo。' : error.message;
  console.error('操作失败：'+message);
  process.exitCode=1;
}
main().catch(reportError);
