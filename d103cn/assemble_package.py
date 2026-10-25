"""Assemble the D103CN data-directory runtime from local, verified inputs.

Does not connect to or execute anything on a robot. No firmware is downloaded,
flashed or emulated. Obtain the exact source inputs described in README.md.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def apply_delta(data, delta):
    if sha(data) != delta['baseSha256']:
        raise ValueError('Factory/upstream source hash mismatch; refusing to patch another version')
    previous = len(data)
    for edit in reversed(delta['edits']):
        start, end = edit['start'], edit['end']
        if not 0 <= start <= end <= previous:
            raise ValueError('Invalid/overlapping byte edits')
        data = data[:start]+edit['text'].encode()+data[end:]
        previous = start
    if sha(data) != delta['resultSha256']:
        raise ValueError('Patched script hash mismatch')
    return data


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--features-dir', type=Path, required=True)
    cli.add_argument('--stock-scripts', type=Path, required=True)
    cli.add_argument('--binary', type=Path, required=True)
    cli.add_argument('--camera-binaries', type=Path, required=True)
    cli.add_argument('--output', type=Path, required=True)
    args = cli.parse_args()
    if args.output.exists():
        raise ValueError('Choose a new output directory; existing packages are never overwritten')
    sources = json.loads((HERE/'sdk-sources.json').read_text())
    patches = json.loads((HERE/'sdk-script-deltas.json').read_text())

    def blob(path):
        return subprocess.check_output(['git', '-C', str(args.features_dir.resolve()),
                                        'show', sources['upstreamFeaturesCommit']+':'+path])

    files = {p.relative_to(HERE/'runtime').as_posix(): p.read_bytes()
             for p in (HERE/'runtime').rglob('*') if p.is_file()}
    for name in ('miio_client', 'libjson-c.so.2', 'miio_client_helper_nomqtt.sh'):
        info = sources['files'][name]
        data = blob(info['source'])
        if sha(data) != info['sourceSha256']:
            raise ValueError('Pinned SDK source hash mismatch: '+name)
        for edit in info['changes']:
            before, after = edit['from'].encode(), edit['to'].encode()
            if len(before) != len(after) or data.count(before) != edit['occurrences']:
                raise ValueError('SDK endpoint patch does not match source')
            data = data.replace(before, after)
        if sha(data) != info['candidateSha256']:
            raise ValueError('SDK candidate hash mismatch')
        if name == 'miio_client_helper_nomqtt.sh':
            files['dreame-sdk/helper-trial.sh'] = apply_delta(data, patches['helper-trial.sh'])
        else:
            files['dreame-sdk/'+name] = data
    for original, target in [('msg_cvt.sh', 'msg-cvt-trial.sh'), ('fds_hook.sh', 'fds-hook-trial.sh')]:
        files['dreame-sdk/'+target] = apply_delta((args.stock_scripts/original).read_bytes(), patches[target])
    for name, path in [('hosts-local', 'valetudo/deployment/etc/hosts-local'), ('nsswitch.conf', 'nsswitch/nsswitch.conf')]:
        files['dreame-sdk/'+name] = blob(path)
    for name, path in [('valetudo', args.binary), ('camera-frames', args.camera_binaries/'camera-frames'),
                       ('camera-controls', args.camera_binaries/'camera-controls')]:
        data = path.read_bytes()
        if data[:6] != b'\x7fELF\x01\x01' or data[18:20] != b'\x28\0':
            raise ValueError('Expected a little-endian ARM32 ELF: '+name)
        files[name] = data
    files['LICENSE'] = (HERE.parent/'LICENSE').read_bytes().replace(b'\r\n', b'\n')
    files['LICENSE-Tasshack'] = (HERE/'LICENSE-Tasshack').read_bytes()
    files['BUILD.json'] = (json.dumps({'model': 'xiaomi.vacuum.d103cn', 'testedFirmware': '4.5.6_1409',
        'upstreamBaseline': '359a212e6897a31cea8df623b107fcb4a1373386',
        'binary_sha256': sha(files['valetudo']), 'autostartEnabledByPackage': False}, indent=2)+'\n').encode()
    files['SHA256SUMS'] = ''.join(f'{sha(data)}  {name}\n' for name, data in sorted(files.items())).encode()
    args.output.mkdir(parents=True)
    for name, data in files.items():
        path = args.output/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o700 if name.endswith('.sh') or name in {'valetudo', 'camera-frames', 'camera-controls'} else 0o600)
    print(f'Assembled {len(files)} files locally in {args.output}. Nothing installed on a robot.')


if __name__ == '__main__':
    main()
