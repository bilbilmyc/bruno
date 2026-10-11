"""Validation shared by the read-only preparer and the privileged publisher."""
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request

UPSTREAM = 'usebruno/bruno'


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('Only stable numeric versions are supported')
    return tuple(map(int, value.split('.')))


def release_lock(release, current):
    tag = release['tag_name']
    if release.get('draft') or release.get('prerelease') or not tag.startswith('v'):
        raise ValueError('Not a stable upstream release')
    target = tag[1:]
    if version(target) < version(current):
        raise ValueError('Refusing an upstream downgrade')
    assets = {}
    for platform, suffix in [('win32', 'x64_win'), ('darwin', 'arm64_mac')]:
        name = f'bruno_{target}_{suffix}.zip'
        matches = [a for a in release['assets'] if a['name'] == name]
        if len(matches) != 1 or not re.fullmatch(r'sha256:[a-f0-9]{64}', matches[0].get('digest') or ''):
            raise ValueError(f'Missing unique asset and official SHA-256: {name}')
        assets[platform] = {'name': name, 'sha256': matches[0]['digest'][7:]}
    return {'version': target, 'tag': tag, 'repository': UPSTREAM, 'assets': assets}


def download(url, destination, digest):
    destination = pathlib.Path(destination)
    if not destination.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'bruno-zh-maintenance'})
        with urllib.request.urlopen(request, timeout=120) as response, destination.open('wb') as output:
            import shutil
            shutil.copyfileobj(response, output)
    if file_hash(destination) != digest:
        raise ValueError('Downloaded official asset SHA-256 mismatch')


def file_hash(file):
    with pathlib.Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def maintained(name):
    return name.startswith(('tools/zh-cn/', '.github/workflows/', '.github/upstream-workflows/')) or name == 'README.zh-CN-patch.md'


def coverage_gate(previous, current):
    if {r['platform'] for r in current} != {'win32', 'darwin'}:
        raise ValueError('Missing native platform coverage')
    for old in previous:
        new = next(r for r in current if r['platform'] == old['platform'])
        if not old['edits'] * .8 <= new['edits'] <= old['edits'] * 1.5:
            raise ValueError('Translation scope changed too far; review the new bundle structure')
        if new['translations'] < old['translations'] * .8:
            raise ValueError('Translation coverage regressed')


def verify_package(folder, platform, commit, lock):
    import zipfile
    folder = pathlib.Path(folder)
    report = json.loads((folder / f'{platform}-verification.json').read_text())
    for key in ('passed', 'nativeSmoke', 'restoreByteIdentical'):
        if report.get(key) is not True:
            raise ValueError(f'Failed native gate: {key}')
    if report['sourceCommit'] != commit or report['version'] != lock['version'] or report['platform'] != platform:
        raise ValueError('Native evidence does not match candidate commit/version/platform')
    suffix, binary, arch = ('Windows-x64', 'bruno-zh-windows.exe', 'x64') if platform == 'win32' else ('macOS-arm64', 'bruno-zh-macos-arm64', 'arm64')
    if report['arch'] != arch:
        raise ValueError('Wrong native architecture')
    archive = folder / f'Bruno-{lock["version"]}-zh-CN-{suffix}.zip'
    digest = file_hash(archive)
    if (folder / (archive.name + '.sha256')).read_text().split()[0] != digest:
        raise ValueError('Package checksum mismatch')
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip() is not None:
            raise ValueError('Damaged ZIP')
        if hashlib.sha256(zipped.read(binary)).hexdigest() != report['executableSha256']:
            raise ValueError('Packaged executable was not the tested binary')
        packaged = json.loads(zipped.read('source/upstream-lock.json'))
        if packaged != lock:
            raise ValueError('Packaged upstream identity differs from candidate')
        for line in zipped.read('SHA256SUMS.txt').decode().splitlines():
            expected, name = line.split('  ', 1)
            if hashlib.sha256(zipped.read(name)).hexdigest() != expected:
                raise ValueError('Internal ZIP manifest mismatch')
    return archive, digest
