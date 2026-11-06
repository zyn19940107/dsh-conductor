"""One-off: rewrite the four bigread file paths to forward slashes.

The task text is a JS string literal, so a Windows path written with single
backslashes turns \\t and \\v into control characters and the model receives a
path it cannot open. Forward slashes work the same on Windows and survive the
string literal untouched.

Usage: python bench/fix-bigread.py
"""

import pathlib

path = pathlib.Path('bench/scenarios.mjs')
text = path.read_text(encoding='utf-8')

pairs = [
    (r"'1. packages\extensions\tool-cordis\src\api-catalog.ts',",
     "'1. packages/extensions/tool-cordis/src/api-catalog.ts',"),
    (r"'2. packages\extensions\cordis-client-runner\src\client\slot-catalog.ts',",
     "'2. packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',"),
    (r"'3. packages\typert\generator\src\analyzer.ts',",
     "'3. packages/typert/generator/src/analyzer.ts',"),
    (r"'4. packages\core\tools\src\index.ts',",
     "'4. packages/core/tools/src/index.ts',"),
]

for old, new in pairs:
    if old not in text:
        print('miss:', old[:50])
        continue
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8', newline='\n')
print('bigread paths rewritten')
