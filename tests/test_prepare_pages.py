"""The Pages deployment must serve exactly the reviewed artifact bytes."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('prepare_pages', ROOT / 'scripts/prepare-pages.py')
PAGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAGES)
SHA = '1' * 40


class AcceptedDemo(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pactspan-pages-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.files = {name: ('content:' + name).encode() for name in PAGES.STATIC}
        self.files['LICENSE'] = (ROOT / 'LICENSE').read_bytes()
        self.rows = [{'path': name, 'bytes': len(data), 'sha256': PAGES.digest(data)}
                     for name, data in sorted(self.files.items()) if name in PAGES.STATIC]
        self.files['pactspan-demo-output.json'] = json.dumps({'format': 'pactspan-demo-output-v1', 'files': self.rows}).encode()

    def build(self, change=None, extra=None):
        content = io.BytesIO()
        with zipfile.ZipFile(content, 'w') as archive:
            for name, data in self.files.items():
                archive.writestr('pactspan-demo/' + name, change(name, data) if change else data)
            if extra:
                archive.writestr(*extra)
        archive_bytes = content.getvalue()
        self.archive = self.root / 'demo.zip'
        self.archive.write_bytes(archive_bytes)
        manifest = {'product': 'pactspan', 'version': '0.1.0', 'source_sha': SHA,
                    'static_files': self.rows, 'artifacts': [{'name': 'pactspan-demo-0.1.0.zip',
                    'bytes': len(archive_bytes), 'sha256': PAGES.digest(archive_bytes)}]}
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_bytes(json.dumps(manifest).encode())
        self.manifest_hash = PAGES.digest(self.manifest.read_bytes())

    def prepare(self, **overrides):
        args = dict(manifest_path=self.manifest, archive_path=self.archive, source_sha=SHA,
                    manifest_sha256=self.manifest_hash, output=self.root / 'output')
        args.update(overrides)
        return PAGES.prepare(**args)

    def test_accepted_bytes_are_written_unchanged(self):
        self.build()
        self.assertEqual(self.prepare()['files'], len(self.files))
        for name, data in self.files.items():
            self.assertEqual((self.root / 'output' / name).read_bytes(), data)

    def test_wrong_source_or_manifest_digest_cannot_create_output(self):
        self.build()
        for override in ({'source_sha': '2' * 40}, {'manifest_sha256': '0' * 64}):
            with self.assertRaises(ValueError):
                self.prepare(**override)
            self.assertFalse((self.root / 'output').exists())

    def test_archive_damage_cannot_create_output(self):
        self.build()
        self.archive.write_bytes(self.archive.read_bytes() + b'changed')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse((self.root / 'output').exists())

    def test_rehashed_archive_with_wrong_member_bytes_is_refused(self):
        self.build(change=lambda name, data: b'changed' if name == 'app.mjs' else data)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse((self.root / 'output').exists())

    def test_unexpected_archive_path_is_refused(self):
        self.build(extra=('pactspan-demo/../../outside', b'escape'))
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse((self.root / 'outside').exists())
        self.assertFalse((self.root / 'output').exists())

    def test_existing_output_is_preserved(self):
        self.build()
        output = self.root / 'output'
        output.mkdir()
        marker = output / 'user-file'
        marker.write_bytes(b'keep')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(marker.read_bytes(), b'keep')


if __name__ == '__main__':
    unittest.main()
