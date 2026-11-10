"""Deploy the accepted demo archive without rebuilding it. Python 3, stdlib only."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import zipfile


STATIC = {
    'index.html', 'app.mjs', 'local.mjs', 'mark.svg', 'styles.css',
    'core/data.mjs', 'core/engine.mjs', 'core/money.mjs', 'core/source.mjs',
    'core/terms.mjs', 'adapters/demo.mjs', 'data/development.mjs',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(manifest_path, archive_path, source_sha, manifest_sha256, output):
    if not re.fullmatch(r'[a-f0-9]{40}', source_sha) or not re.fullmatch(r'[a-f0-9]{64}', manifest_sha256):
        raise ValueError('Expected full source SHA and accepted manifest SHA256')
    if output.exists() or output.is_symlink():
        raise ValueError('Choose a fresh output directory')
    manifest_bytes = manifest_path.read_bytes()
    if len(manifest_bytes) > 65536 or digest(manifest_bytes) != manifest_sha256:
        raise ValueError('Accepted release manifest digest differs')
    manifest = json.loads(manifest_bytes)
    if manifest.get('product') != 'pactspan' or manifest.get('source_sha') != source_sha:
        raise ValueError('Release product/source differs from this checkout')
    version = manifest.get('version', '')
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Unsupported release version')
    artifacts = [row for row in manifest['artifacts'] if row['name'] == f'pactspan-demo-{version}.zip']
    if len(artifacts) != 1:
        raise ValueError('Missing or duplicate demo artifact')
    archive_bytes = archive_path.read_bytes()
    if len(archive_bytes) > 8 * 1024 * 1024 or artifacts[0]['bytes'] != len(archive_bytes) or artifacts[0]['sha256'] != digest(archive_bytes):
        raise ValueError('Demo archive differs from the accepted artifact')
    rows = manifest['static_files']
    if len(rows) != len(STATIC) or {row['path'] for row in rows} != STATIC:
        raise ValueError('Unexpected static file inventory')
    expected = {row['path']: row for row in rows}
    permitted = STATIC | {'LICENSE', 'pactspan-demo-output.json'}
    files = {}
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        if len(archive.infolist()) != len(permitted) or sum(row.file_size for row in archive.infolist()) > 8 * 1024 * 1024:
            raise ValueError('Unexpected archive size/inventory')
        for item in archive.infolist():
            name = item.filename.removeprefix('pactspan-demo/')
            mode = item.external_attr >> 16
            if item.filename != 'pactspan-demo/' + name or name not in permitted or name in files or item.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                raise ValueError('Unsupported archive member')
            data = archive.read(item)
            if name in expected and (len(data) != expected[name]['bytes'] or digest(data) != expected[name]['sha256']):
                raise ValueError('Static file digest differs: ' + name)
            files[name] = data
    ownership = json.loads(files['pactspan-demo-output.json'])
    if ownership.get('format') != 'pactspan-demo-output-v1' or ownership.get('files') != rows:
        raise ValueError('Demo ownership manifest differs')
    if files['LICENSE'] != (Path(__file__).resolve().parent.parent / 'LICENSE').read_bytes():
        raise ValueError('Release license differs from source')
    output.mkdir()
    for name, data in files.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return {'source_sha': source_sha, 'manifest_sha256': manifest_sha256, 'archive_sha256': digest(archive_bytes), 'files': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.manifest, args.archive, args.source_sha, args.manifest_sha256, args.out), indent=2))
