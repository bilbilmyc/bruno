import copy
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from common import coverage_gate, file_hash, release_lock, run, verify_package
from translate import eligible, validate
import prepare


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.release = {'tag_name': 'v4.3.0', 'draft': False, 'prerelease': False, 'assets': [
            {'name': f'bruno_4.3.0_{suffix}.zip', 'digest': 'sha256:' + 'a' * 64}
            for suffix in ('x64_win', 'arm64_mac')]}

    def test_release_rejects_prerelease_downgrade_missing_or_duplicate_assets(self):
        self.assertEqual(release_lock(self.release, '4.2.1')['version'], '4.3.0')
        for field in ('prerelease', 'draft'):
            bad = copy.deepcopy(self.release)
            bad[field] = True
            with self.assertRaises(ValueError): release_lock(bad, '4.2.1')
        with self.assertRaises(ValueError): release_lock(self.release, '5.0.0')
        bad = copy.deepcopy(self.release)
        del bad['assets'][0]['digest']
        with self.assertRaises(ValueError): release_lock(bad, '4.2.1')
        bad = copy.deepcopy(self.release)
        bad['assets'].append(bad['assets'][0])
        with self.assertRaises(ValueError): release_lock(bad, '4.2.1')
        bad['tag_name'] = 'v4.3.0;echo unsafe'
        with self.assertRaises(ValueError): release_lock(bad, '4.2.1')

    def test_translation_excludes_data_and_preserves_numbers_protocol_names(self):
        self.assertTrue(eligible('Create a new folder'))
        for value in ['GET', 'https://test.example', 'userId', 'Hello ${name}', 'a=b', 'bruno.json', '<html>', 'Bearer token']:
            self.assertFalse(eligible(value), value)
        self.assertEqual(validate('HTTP timeout 30', 'HTTP 超时 30'), 'HTTP 超时 30')
        for value in ['HTTP timeout 30', 'HTTP 超时 60', '超时 30', 'HTTP 超时=30']:
            with self.assertRaises(ValueError): validate('HTTP timeout 30', value)

    def test_coverage_rejects_bundle_shape_regression(self):
        baseline = [{'platform': p, 'edits': 100, 'translations': 50} for p in ('win32', 'darwin')]
        coverage_gate(baseline, baseline)
        for key in ('edits', 'translations'):
            bad = copy.deepcopy(baseline)
            bad[0][key] = 2
            with self.assertRaises(ValueError): coverage_gate(baseline, bad)
        with self.assertRaises(ValueError): coverage_gate(baseline, baseline[:1])

    def test_publisher_rejects_wrong_commit_arch_and_tampered_binary(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = pathlib.Path(temp)
            lock = release_lock(self.release, '4.2.1')
            binary = b'tested executable'
            digest = hashlib.sha256(binary).hexdigest()
            archive = folder / 'Bruno-4.3.0-zh-CN-Windows-x64.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('bruno-zh-windows.exe', binary)
                z.writestr('source/upstream-lock.json', json.dumps(lock))
                z.writestr('SHA256SUMS.txt', digest + '  bruno-zh-windows.exe\n')
            (folder / (archive.name + '.sha256')).write_text(file_hash(archive))
            report = {'passed': True, 'nativeSmoke': True, 'restoreByteIdentical': True,
                      'sourceCommit': 'a' * 40, 'version': '4.3.0', 'platform': 'win32', 'arch': 'x64', 'executableSha256': digest}
            target = folder / 'win32-verification.json'
            target.write_text(json.dumps(report))
            verify_package(folder, 'win32', 'a' * 40, lock)
            for key, value in [('sourceCommit', 'b' * 40), ('arch', 'arm64'), ('nativeSmoke', False), ('executableSha256', '0' * 64)]:
                changed = {**report, key: value}
                target.write_text(json.dumps(changed))
                with self.assertRaises(ValueError): verify_package(folder, 'win32', 'a' * 40, lock)

    def test_source_sync_keeps_overlay_inactivates_upstream_workflows_and_protects_user_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = pathlib.Path(temp)
            def git(*args): return run('git', *args, cwd=repo)
            def write(name, value):
                p = repo / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(value)
            git('init', '-q')
            git('config', 'user.name', 'test')
            git('config', 'user.email', 'test@example.invalid')
            write('app.txt', 'old')
            write('.github/workflows/upstream.yml', 'old')
            git('add', '.')
            git('commit', '-qm', 'old upstream')
            old = git('rev-parse', 'HEAD')
            git('checkout', '-qb', 'new-upstream')
            write('app.txt', 'new')
            write('.github/workflows/new.yml', 'unrelated upstream publisher')
            git('add', '.')
            git('commit', '-qm', 'new upstream')
            new = git('rev-parse', 'HEAD')
            git('checkout', '-qb', 'localized', old)
            for p in ['tools/zh-cn/owned.txt', 'README.zh-CN-patch.md', '.github/workflows/zh-ci.yml', '.github/workflows/zh-update.yml']:
                write(p, 'keep')
            git('add', '.')
            git('commit', '-qm', 'overlay')
            base = git('rev-parse', 'HEAD')
            with patch.object(prepare, 'REPO', repo), patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}):
                prepare.synchronize_source(base, old, new)
                self.assertEqual((repo / 'app.txt').read_text(), 'new')
                self.assertEqual((repo / 'tools/zh-cn/owned.txt').read_text(), 'keep')
                self.assertFalse((repo / '.github/workflows/new.yml').exists())
                self.assertTrue((repo / '.github/upstream-workflows/new.yml').exists())
                git('reset', '--hard', base)
                write('app.txt', 'user customization')
                git('add', '.')
                git('commit', '-qm', 'user customization')
                customized = git('rev-parse', 'HEAD')
                with self.assertRaises(ValueError): prepare.synchronize_source(customized, old, new)
                self.assertEqual((repo / 'app.txt').read_text(), 'user customization')

    def test_pending_bundle_requires_history_available_in_native_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / 'source'
            source.mkdir()
            def git(*args): return run('git', *args, cwd=source)
            git('init', '-q')
            git('config', 'user.name', 'test')
            git('config', 'user.email', 'test@example.invalid')
            for content in ('before', 'pending release'):
                (source / 'state').write_text(content)
                git('add', '.')
                git('commit', '-qm', content)
            git('branch', 'zh-candidate')
            bundle = root / 'pending.bundle'
            git('bundle', 'create', str(bundle), 'HEAD^..zh-candidate')
            shallow = root / 'native'
            run('git', 'clone', '-q', '--depth', '1', source.as_uri(), str(shallow))
            result = subprocess.run(['git', 'bundle', 'verify', str(bundle)], cwd=shallow, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            run('git', 'fetch', '--unshallow', cwd=shallow)
            run('git', 'fetch', str(bundle), 'zh-candidate', cwd=shallow)
            self.assertEqual(run('git', 'rev-parse', 'FETCH_HEAD', cwd=shallow), git('rev-parse', 'HEAD'))


if __name__ == '__main__':
    unittest.main()
