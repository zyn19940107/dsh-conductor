"""Find (and optionally fix) Windows paths written with one backslash in the task sources.

A path like D:\\code\\vibe in a JS string literal is fine; D:\\code\\vibe with one
backslash is not: \\v becomes a control character and the model receives a path it
cannot open. This walks bench/*.mjs, reports every line holding such a path, and
with --apply doubles the backslashes of the path itself (and nothing else).

Usage: python bench/fix-paths.py [--apply]
"""

import pathlib
import re
import sys

APPLY = '--apply' in sys.argv

PATH_PATTERN = re.compile(r'[A-Za-z]:\\(?:[A-Za-z0-9_. -]+\\?)+')
FLAG = re.compile(r'\\')


def lines_with_broken_paths(text):
    """Yield (lineno, line) for lines whose Windows path uses one backslash."""
    for lineno, line in enumerate(text.split('\n'), 1):
        for match in PATH_PATTERN.finditer(line):
            path = match.group(0)
            # A correct path in the source is written with doubled backslashes,
            # so the raw match would not contain a bare '\' between letters.
            if '\\\\' not in path:
                yield lineno, line, path
                break


total = 0
for name in sorted(pathlib.Path('bench').glob('*.mjs')):
    text = name.read_text(encoding='utf-8')
    broken = list(lines_with_broken_paths(text))
    if not broken:
        continue
    for lineno, _line, path in broken:
        print(f'{name}:{lineno}: {path}')
        total += 1
    if APPLY:
        fixed = text
        for _lineno, _line, path in broken:
            fixed = fixed.replace(path, path.replace('\\', '\\\\'))
        name.write_text(fixed, encoding='utf-8', newline='\n')

print(f'\n{total} broken path(s)' + ('; fixed' if APPLY and total else ''))
