#!/usr/bin/env python3
"""Migrate only the former default; never execute a sweep or evaluate .env code."""
import argparse
import datetime
import os
import pathlib
import re
import shlex
import stat
import tempfile
import uuid

OLD = '0 6 * * 2,6'
NEW = '0 6 * * 2,4,6'
KEY = 'TRONFIRE_FIREBIRD_SWEEP_CRON'
ENABLED = 'TRONFIRE_FIREBIRD_SWEEP_ENABLED'
PRESERVE = 'TRONFIRE_FIREBIRD_SWEEP_PRESERVE_SCHEDULE'
DISABLED = {'0', 'false', 'off', 'disabled', 'never'}


def migrate(env_path, backup_dir):
    env_path = pathlib.Path(env_path)
    if env_path.is_symlink():
        raise ValueError('Sweep migration refuses a symbolic link configuration')
    metadata = env_path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('Sweep configuration must be a regular file')
    original = env_path.read_bytes()
    lines = original.decode('utf-8').splitlines(keepends=True)
    assignments = {}
    for index, line in enumerate(lines):
        match = re.match(r'^\s*(?:export\s+)?(' + KEY + '|' + ENABLED + '|' + PRESERVE + r')\s*=\s*(.*?)(?:\r?\n)?$', line)
        if not match:
            continue
        key, raw = match.groups()
        if key in assignments:
            raise ValueError('Duplicate sweep configuration: ' + key)
        assignments[key] = (index, ' '.join(shlex.split(raw, comments=True)))
    if assignments.get(PRESERVE, (None, 'false'))[1].lower() in {'1', 'true', 'yes', 'on'}:
        return 'explicit preserve: unchanged'
    if assignments.get(ENABLED, (None, 'true'))[1].lower() in DISABLED:
        return 'disabled: preserved'
    if KEY not in assignments:
        return 'unset: new compose/worker default applies'
    index, current = assignments[KEY]
    if ' '.join(current.split()) != OLD:
        return 'custom or already migrated: preserved'
    ending = '\r\n' if lines[index].endswith('\r\n') else '\n' if lines[index].endswith('\n') else ''
    comment = re.search(r'\s+(#.*?)(?:\r?\n)?$', lines[index])
    lines[index] = KEY + '="' + NEW + '"' + (' ' + comment.group(1) if comment else '') + ending
    replacement = ''.join(lines).encode('utf-8')
    backup_dir = pathlib.Path(backup_dir)
    backup_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = backup_dir / ('sweep-schedule-' + stamp + '-' + uuid.uuid4().hex[:8] + '.env')
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(original)
        output.flush()
        os.fsync(output.fileno())
    descriptor, temporary = tempfile.mkstemp(prefix='.sweep-schedule-', dir=env_path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            if hasattr(os, 'fchown'):
                os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            output.write(replacement)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, env_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return 'migrated: Tuesday/Thursday/Saturday 06:00; backup ' + str(backup)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--env', required=True)
    parser.add_argument('--backup-dir', required=True)
    arguments = parser.parse_args()
    print('[sweep-schedule] ' + migrate(arguments.env, arguments.backup_dir))
