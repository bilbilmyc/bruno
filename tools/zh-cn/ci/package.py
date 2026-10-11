import hashlib, json, os, pathlib, stat, sys, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
lock = json.loads((root / 'upstream-lock.json').read_text())
mac = sys.platform == 'darwin'
platform = 'macOS-arm64' if mac else 'Windows-x64'
name = 'bruno-zh-macos-arm64' if mac else 'bruno-zh-windows.exe'
artifact = root / 'artifacts'
artifact.mkdir(exist_ok=True)
verification=json.loads((artifact/('darwin-verification.json' if mac else 'win32-verification.json')).read_text())
assert verification['passed'] and verification['nativeSmoke'] and verification['restoreByteIdentical']
assert verification['version']==lock['version']
assert verification['executableSha256']==hashlib.file_digest((root/'dist'/name).open('rb'),'sha256').hexdigest()
if os.environ.get('GITHUB_SHA'): assert verification['sourceCommit']==os.environ['GITHUB_SHA']
archive = artifact / f'Bruno-{lock["version"]}-zh-CN-{platform}.zip'
files = [(root/'dist'/name, name), (root/'README.md', '使用说明.md'), (root.parents[1]/'license.md','Bruno-LICENSE.txt')]
files += [(p,'source/'+p.name) for p in root.iterdir() if p.is_file() and p.suffix in ('.mjs','.cjs','.json','.txt') and not p.name.startswith('missing-')]
checks = []
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p,target in files:
        content=p.read_bytes()
        info=zipfile.ZipInfo(target);info.create_system=3;info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=(stat.S_IFREG | (0o755 if target==name else 0o644))<<16
        z.writestr(info,content)
        checks.append(hashlib.sha256(content).hexdigest()+'  '+target)
    z.writestr('SHA256SUMS.txt','\n'.join(checks)+'\n')
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
(artifact/(archive.name+'.sha256')).write_text(digest+'  '+archive.name+'\n')
print(archive.name,digest)
