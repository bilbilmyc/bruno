"""Executed from the scheduler commit, never from untested upstream code."""
import json
import os
import pathlib
import re
from common import run, verify_package

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
ARTIFACTS = ROOT / 'work/delivery'


def main():
    if os.environ.get('GITHUB_REF') != 'refs/heads/zh-cn' or os.environ.get('GITHUB_EVENT_NAME') not in ('schedule', 'workflow_dispatch'):
        raise ValueError('Publication is only allowed from the maintenance branch')
    meta = json.loads((ARTIFACTS / 'zh-candidate/candidate.json').read_text())
    if meta['mode'] not in ('check', 'rebuild'):
        raise ValueError('Rehearsals must never publish')
    if not all(re.fullmatch(r'[a-f0-9]{40}', meta[k]) for k in ('base', 'commit')):
        raise ValueError('Invalid candidate commit')
    if meta['base'] != os.environ['GITHUB_SHA']:
        raise ValueError('Candidate belongs to another workflow revision')
    tag, lock = meta['tag'], meta['lock']
    if not re.fullmatch(re.escape('v' + lock['version']) + r'-zh\.[1-9]\d*', tag):
        raise ValueError('Invalid release tag')
    repo = os.environ['GITHUB_REPOSITORY']
    files, checks = [], []
    for folder, platform in [('zh-windows-latest', 'win32'), ('zh-macos-15', 'darwin')]:
        archive, digest = verify_package(ARTIFACTS / folder, platform, meta['commit'], lock)
        files += [str(archive), str(archive) + '.sha256']
        checks.append(digest + '  ' + archive.name)
    run('git', 'fetch', str(ARTIFACTS / 'zh-candidate/candidate.bundle'), 'zh-candidate', cwd=REPO)
    if run('git', 'rev-parse', 'FETCH_HEAD', cwd=REPO) != meta['commit']:
        raise ValueError('Bundle does not contain the tested commit')
    run('git', 'merge-base', '--is-ancestor', meta['base'], meta['commit'], cwd=REPO)
    actual_lock = json.loads(run('git', 'show', meta['commit'] + ':tools/zh-cn/upstream-lock.json', cwd=REPO))
    if actual_lock != lock:
        raise ValueError('Candidate upstream lock mismatch')
    remote = run('git', 'ls-remote', 'origin', 'refs/heads/zh-cn', cwd=REPO).split()[0]
    if remote != meta['base']:
        raise ValueError('Maintenance branch changed during testing; rerun on its latest commit')
    existing = json.loads(run('gh', 'release', 'list', '--repo', repo, '--limit', '1000', '--json', 'tagName,isDraft'))
    release = next((r for r in existing if r['tagName'] == tag), None)
    if release and not release['isDraft']:
        raise ValueError('Never replace an already published release')
    sums = ARTIFACTS / 'SHA256SUMS.txt'
    sums.write_text('\n'.join(checks) + '\n', encoding='utf8')
    files.append(str(sums))
    notes = ARTIFACTS / 'release.md'
    notes.write_text(f'''Bruno **{lock['version']}** 简体中文补丁，支持 Windows x64 / Mac M 芯片（macOS 13+）。

由 GitHub Actions 自动适配并构建。既有词库保留，新静态文案使用固定版本离线翻译模型；部分动态或技术文案仍可能为英文。

Windows 和真实 ARM64 Mac 的启动、请求、保存、加密兼容、重复应用及完整恢复测试均通过。

先退出 Bruno。Windows 解压后以管理员身份运行，输入 1 汉化、2 恢复。Mac 按 ZIP 内使用说明执行。Mac 首次启动可能需要 Gatekeeper 允许及钥匙串手动授权；补丁不读取登录密码。

**升级官方版本前先恢复原版，升级后再使用匹配版本的新补丁。**

[本次验证](https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}) · [使用说明](https://github.com/{repo}/blob/{meta['commit']}/tools/zh-cn/README.md) · [新增译文](https://github.com/{repo}/blob/{meta['commit']}/tools/zh-cn/maintenance/translation-report.json)

这是非官方补丁。下载 ZIP 与对应校验文件，不要下载页面自动生成的 Source code 作为安装包。
''', encoding='utf8')
    # No force push. A concurrent user commit makes this fail without overwriting it.
    run('git', 'push', 'origin', meta['commit'] + ':refs/heads/zh-cn', cwd=REPO)
    if not release:
        run('gh', 'release', 'create', tag, '--repo', repo, '--target', meta['commit'], '--draft', '--title', f'Bruno {lock["version"]} 简体中文补丁', '--notes-file', str(notes))
    else:
        run('gh', 'release', 'edit', tag, '--repo', repo, '--notes-file', str(notes))
    run('gh', 'release', 'upload', tag, '--repo', repo, '--clobber', *files)
    uploaded = json.loads(run('gh', 'release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft,targetCommitish'))
    if not uploaded['isDraft'] or uploaded['targetCommitish'] != meta['commit']:
        raise ValueError('Draft points to a different candidate')
    from common import file_hash
    if {a['name'] for a in uploaded['assets']} != {pathlib.Path(f).name for f in files}:
        raise ValueError('Unexpected release asset set')
    for file in files:
        asset = next(a for a in uploaded['assets'] if a['name'] == pathlib.Path(file).name)
        if asset['digest'] != 'sha256:' + file_hash(file):
            raise ValueError('Uploaded asset digest mismatch; keeping release in draft')
    run('gh', 'release', 'edit', tag, '--repo', repo, '--draft=false', '--latest')
    print(f'Published https://github.com/{repo}/releases/tag/{tag}')


if __name__ == '__main__':
    main()
