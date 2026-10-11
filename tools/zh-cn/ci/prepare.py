"""Download only the pinned official release and verify its digest before extraction."""
import hashlib, json, os, pathlib, subprocess, sys, urllib.request, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
lock = json.loads((root / 'upstream-lock.json').read_text())
platform = 'darwin' if sys.platform == 'darwin' else 'win32'
if sys.platform not in ('darwin', 'win32'):
    raise SystemExit('Native validation requires Windows or macOS')
asset = lock['assets'][platform]
work = root / 'work'
work.mkdir(exist_ok=True)
archive = work / asset['name']
url = f"https://github.com/{lock['repository']}/releases/download/{lock['tag']}/{asset['name']}"
if not archive.exists():
    urllib.request.urlretrieve(url, archive)
with archive.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == asset['sha256'], 'Official ZIP digest mismatch'
if platform == 'darwin':
    subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(work)], check=True)
    app = work / 'Bruno.app'
else:
    app = work / 'bruno-test'
    with zipfile.ZipFile(archive) as z:
        assert all(not n.startswith(('/', '\\')) and '..' not in pathlib.PurePosixPath(n).parts for n in z.namelist())
        z.extractall(app)
if 'GITHUB_ENV' in os.environ:
    with open(os.environ['GITHUB_ENV'], 'a', encoding='utf8') as stream:
        stream.write(f'BRUNO_TEST_APP={app}\n')
print(f'Official {platform} {lock["version"]} archive verified and extracted')
