const fs = require('fs'), path = require('path'), acorn = require('acorn'), walk = require('acorn-walk');
const root = __dirname;
const normalize = s => s.trim().replace(/\s+/g, ' ').toLowerCase();
const translations = new Map();
const exact = new Map();
for (const row of fs.readFileSync(path.join(root, 'translations.txt'), 'utf8').split(/\r?\n/)) {
  if (!row.trim()) continue;
  const split = row.lastIndexOf('=');
  if (split < 1) throw new Error('Invalid dictionary row: ' + row);
  const key = normalize(row.slice(0, split)), value = row.slice(split + 1);
  exact.set(row.slice(0, split).trim().replace(/\s+/g, ' '), value);
  if (translations.has(key) && translations.get(key) !== value) translations.set(key, null);
  else translations.set(key, value);
}
const props = new Set(['children', 'label', 'title', 'placeholder', 'aria-label', 'ariaLabel', 'tooltip', 'confirmText', 'cancelText', 'submitText', 'buttonText']);
function candidates(source) {
  const result = [];
  const ast = acorn.parse(source, { ecmaVersion: 'latest' });
  walk.ancestor(ast, { Literal(node, ancestors) {
    if (typeof node.value !== 'string') return;
    if (ancestors.some(a=>a.type==='CallExpression' && /\.(jsx|jsxs|createElement)\)?$/.test(source.slice(a.callee.start,a.callee.end)) &&
      (['code','pre'].includes(a.arguments[0]?.value) || a.arguments[0]?.value==='option' && !a.arguments[1]?.properties?.some(p=>(p.key?.name||p.key?.value)==='value')))) return;
    let current = node;
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const parent = ancestors[i];
      if (parent.type === 'ConditionalExpression' && current !== parent.test ||
          parent.type === 'LogicalExpression' && current === parent.right || parent.type === 'ArrayExpression') {
        current = parent; continue;
      }
      if (parent.type === 'Property' && !parent.computed && parent.value === current) {
        const key = parent.key.name || parent.key.value;
        const object = ancestors[i-1], call = ancestors[i-2];
        const objectKeys = object?.type === 'ObjectExpression' ? object.properties.map(p=>p.key?.name||p.key?.value) : [];
        const uiProp = ['text','content','description','message','infotip'].includes(key) && call?.type === 'CallExpression' && /\.(jsx|jsxs|createElement)\)?$/.test(source.slice(call.callee.start,call.callee.end));
        const column = key === 'name' && (objectKeys.includes('accessor') || objectKeys.includes('key') && objectKeys.some(k=>['render','width','isKeyField','sortable'].includes(k)));
        if (props.has(key) || uiProp || column) result.push(node);
      }
      // Source-reviewed SendButton label, distinct from its CSS class / action IDs.
      if (parent.type === 'VariableDeclarator' && current.type === 'ConditionalExpression' &&
          current.consequent.value === 'Cancel' && current.alternate.value === 'Send') result.push(node);
      // Shared modal's fallback button text. Restrict to the reviewed destructuring context.
      if (parent.type === 'AssignmentExpression' && current.type === 'LogicalExpression' &&
          ['Save','Cancel'].includes(node.value) && /confirmText:.{0,80}cancelText:/.test(source.slice(Math.max(0,parent.start-500),parent.start))) result.push(node);
      // react-hot-toast's default export in the reviewed production bundle.
      if (parent.type === 'CallExpression' && parent.arguments[0] === node &&
          /^[\w$]+\.ZP\.(success|error|loading)$/.test(source.slice(parent.callee.start,parent.callee.end))) result.push(node);
      break;
    }
  }});
  return { ast, result };
}
async function main() {
  const { openArchive, fileHash, sha256 } = await import(require('url').pathToFileURL(path.join(root, 'archive.mjs')));
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node generate-plans.cjs WINDOWS_APP_ASAR MACOS_ARM64_APP_ASAR');
  const lock = require('./upstream-lock.json');
  const manifest = { patchVersion: require('./package.json').version, brunoVersion: lock.version, builds: [] };
  const coverage = [];
  for (const [platform, file] of [['win32', process.argv[2]], ['darwin', process.argv[3]]]) {
    const archive = openArchive(file);
    const pkg = JSON.parse(archive.read('package.json'));
    if(pkg.name !== 'bruno' || pkg.version !== lock.version) throw new Error('Unexpected upstream archive version');
    const files = [], used = new Set(), missing = new Set();
    const renderer = [...archive.entries.keys()].find(n => /^web\/static\/js\/index\.[a-z0-9]+\.js$/.test(n));
    for (const name of [renderer, 'src/app/menu-template.js', 'web/index.html']) {
      const original = archive.read(name); const source = original.toString('utf8');
      const edits = [];
      if (name.endsWith('.html')) {
        const start = source.indexOf('<html>'); if (start < 0) throw new Error('Missing HTML root');
        edits.push([start, start + 6, '<html>', '<html lang="zh-CN">']);
      } else {
        const { ast, result } = candidates(source);
        for (const node of result) {
          const key = normalize(node.value), translated = exact.get(node.value.trim().replace(/\s+/g, ' ')) || translations.get(key);
          if (!translated) { if (/[a-zA-Z]/.test(key)) missing.add(node.value); continue; }
          // Preserve boundary whitespace used by split text around dynamic values.
          const value = node.value.match(/^\s*/)[0] + translated + node.value.match(/\s*$/)[0];
          edits.push([node.start, node.end, source.slice(node.start, node.end), JSON.stringify(value)]);
          used.add(key);
        }
        if (name.includes('menu-template')) {
          const roles = { undo:'撤销', redo:'重做', cut:'剪切', copy:'复制', paste:'粘贴', selectAll:'全选', hide:'隐藏 Bruno', hideOthers:'隐藏其他应用', toggledevtools:'开发者工具', togglefullscreen:'切换全屏', window:'窗口', minimize:'最小化', close:'关闭', help:'帮助' };
          walk.simple(ast, { ObjectExpression(node) {
            const role = node.properties.find(p => (p.key?.name || p.key?.value) === 'role');
            if (role && roles[role.value.value] && !node.properties.some(p => (p.key?.name || p.key?.value) === 'label')) {
              edits.push([node.start+1,node.start+1,'', `label:${JSON.stringify(roles[role.value.value])},`]);
            }
          }});
        }
      }
      edits.sort((a,b) => a[0]-b[0]);
      let translated = source;
      for (const [start,end,old,value] of [...edits].reverse()) translated = translated.slice(0,start)+value+translated.slice(end);
      if (name.endsWith('.js')) acorn.parse(translated,{ecmaVersion:'latest'});
      files.push({path:name,before:sha256(original),after:sha256(Buffer.from(translated)),edits});
    }
    archive.close();
    manifest.builds.push({platform,arch:platform==='darwin'?'arm64':'x64',archiveSha256:fileHash(file),files});
    coverage.push({platform,translations:used.size,edits:files.reduce((n,f)=>n+f.edits.length,0),remainingStaticCandidates:missing.size});
    fs.writeFileSync(path.resolve(__dirname,`missing-${platform}.json`),JSON.stringify([...missing],null,2));
  }
  fs.writeFileSync(path.join(root,'plans.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.resolve(__dirname,'coverage.json'),JSON.stringify(coverage,null,2));
  console.log(coverage);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
