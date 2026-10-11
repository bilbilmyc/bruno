"""Discover a stable release and build a candidate without repository write access."""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import zipfile
from common import UPSTREAM, coverage_gate, download, maintained, release_lock, run
from translate import extend_dictionary

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
WORK = ROOT / 'work/maintenance'
DELIVERY = ROOT / 'work/candidate'


def write_json(file, data):
    file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def outputs(**values):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf8') as stream:
        for key, value in values.items():
            stream.write(f'{key}={value}\n')


def archive_pair(lock):
    result = []
    for platform in ('win32', 'darwin'):
        asset = lock['assets'][platform]
        packed = WORK / asset['name']
        download(f'https://github.com/{UPSTREAM}/releases/download/{lock["tag"]}/{asset["name"]}', packed, asset['sha256'])
        output = WORK / f'{platform}.asar'
        member = 'Bruno.app/Contents/Resources/app.asar' if platform == 'darwin' else 'resources/app.asar'
        with zipfile.ZipFile(packed) as archive, archive.open(member) as source, output.open('wb') as target:
            shutil.copyfileobj(source, target)
        result.append(str(output))
    return result


def synchronize_source(base, previous, target):
    changed = run('git', 'diff', '--name-only', '--no-renames', previous, base, cwd=REPO).splitlines()
    if any(not maintained(name) for name in changed):
        raise ValueError('Fork has changes outside maintained overlay; refusing to overwrite them')
    # Only an ephemeral clean Actions checkout is reset, never a local installation.
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('Source synchronization is restricted to GitHub runners')
    owned = ['tools/zh-cn', 'README.zh-CN-patch.md', '.github/workflows/zh-ci.yml', '.github/workflows/zh-update.yml']
    if run('git', 'ls-tree', '-r', '--name-only', target, '--', 'tools/zh-cn', 'README.zh-CN-patch.md', cwd=REPO):
        raise ValueError('Upstream now uses a reserved maintenance path')
    run('git', 'read-tree', '--reset', '-u', target, cwd=REPO)
    inactive = REPO / '.github/upstream-workflows'
    if inactive.exists():
        raise ValueError('Upstream uses the reserved inactive-workflow directory')
    inactive.mkdir(parents=True)
    for workflow in (REPO / '.github/workflows').glob('*'):
        if workflow.name in ('zh-ci.yml', 'zh-update.yml'):
            raise ValueError('Upstream workflow name conflicts with maintenance')
        shutil.move(str(workflow), inactive / workflow.name)
    run('git', 'restore', '--source=' + base, '--staged', '--worktree', '--', *owned, cwd=REPO)


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('Run the unit tests locally; preparation belongs on GitHub Actions')
    mode = os.environ.get('UPDATE_MODE', 'check')
    if mode not in ('check', 'rehearse', 'rebuild'):
        raise ValueError('Unknown maintenance mode')
    WORK.mkdir(parents=True, exist_ok=True)
    DELIVERY.mkdir(parents=True, exist_ok=True)
    base = run('git', 'rev-parse', 'HEAD', cwd=REPO)
    previous = json.loads((ROOT / 'upstream-lock.json').read_text())
    latest = json.loads(run('gh', 'api', f'repos/{UPSTREAM}/releases/latest'))
    lock = release_lock(latest, previous['version'])
    repo = os.environ['GITHUB_REPOSITORY']
    releases = json.loads(run('gh', 'release', 'list', '--repo', repo, '--limit', '1000', '--json', 'tagName,isDraft'))
    published = {r['tagName'] for r in releases if not r['isDraft']}
    pending_file = ROOT / 'maintenance/release.json'
    pending = json.loads(pending_file.read_text()) if pending_file.exists() else {}
    resume = (mode == 'check' and lock['version'] == previous['version']
              and pending.get('version') == lock['version'] and pending.get('tag') not in published)
    if mode == 'check' and lock['version'] == previous['version'] and not resume:
        outputs(needed='false')
        print('No new stable upstream release')
        return
    if '--discover' in sys.argv:
        outputs(needed='true')
        return
    if resume:
        lock = previous
        tag = pending['tag']
        commit = base
    else:
        run('git', 'fetch', '--no-tags', f'https://github.com/{UPSTREAM}.git', 'refs/tags/' + lock['tag'], cwd=REPO)
        lock['sourceCommit'] = run('git', 'rev-parse', 'FETCH_HEAD^{commit}', cwd=REPO)
        old_coverage = json.loads((ROOT / 'coverage.json').read_text())
        baseline = json.loads((ROOT / 'maintenance/untranslated-baseline.json').read_text())
        if lock['version'] != previous['version']:
            synchronize_source(base, previous['sourceCommit'], lock['sourceCommit'])
        write_json(ROOT / 'upstream-lock.json', lock)
        # Keep the npm lockfile consistent; no dependency version changes.
        run('npm', 'version', 'patch', '--no-git-tag-version', '--ignore-scripts', cwd=ROOT)
        pair = archive_pair(lock)
        run('node', 'generate-plans.cjs', *pair, cwd=ROOT)
        extend_dictionary(ROOT, baseline)
        run('node', 'generate-plans.cjs', *pair, cwd=ROOT)
        coverage_gate(old_coverage, json.loads((ROOT / 'coverage.json').read_text()))
        missing = set()
        for platform in ('win32', 'darwin'):
            missing.update(json.loads((ROOT / f'missing-{platform}.json').read_text()))
        write_json(ROOT / 'maintenance/untranslated-baseline.json', sorted(missing))
        revisions = [int(match.group(1)) for r in releases
                     if (match := re.fullmatch(re.escape(lock['tag']) + r'-zh\.(\d+)', r['tagName']))]
        tag = f'{lock["tag"]}-zh.{max(revisions, default=0) + 1}'
        write_json(pending_file, {'version': lock['version'], 'tag': tag})
        run('git', 'add', '-A', cwd=REPO)
        tree = run('git', 'write-tree', cwd=REPO)
        parents = ['-p', base]
        if lock['version'] != previous['version']:
            parents += ['-p', lock['sourceCommit']]
        commit = run('git', 'commit-tree', tree, *parents, '-m', f'Update Chinese patch for Bruno {lock["version"]}', cwd=REPO)
    run('git', 'branch', '-f', 'zh-candidate', commit, cwd=REPO)
    # Include at least the candidate commit; checkout already contains its base.
    lower = run('git', 'rev-parse', base + '^', cwd=REPO) if resume else base
    run('git', 'bundle', 'create', str(DELIVERY / 'candidate.bundle'), lower + '..zh-candidate', cwd=REPO)
    metadata = {'base': base, 'commit': commit, 'tag': tag, 'mode': mode, 'lock': lock}
    write_json(DELIVERY / 'candidate.json', metadata)
    outputs(needed='true', commit=commit)
    print(f'Prepared {tag}: {commit}; publication requires both native jobs')


if __name__ == '__main__':
    main()
