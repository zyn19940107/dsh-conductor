"""Align the remaining task texts with the v2.5 report rule.

The plugin now tells every child to report the substance and not the receipts:
no line numbers, no citation trail. Four benchmark tasks still asked for exactly
that ("带行号", "证据行号", "改了哪一行"), which makes the work go into a form the
plugin strips before the parent reads it.

Usage: python bench/fix-receipts.py
"""

import pathlib

edits = {
    'bench/task.mjs': [
        (
            "    '  每个模块给出：它的职责、一个最容易被误用的地方（带行号）、结论。',",
            "    '  每个模块给出：它的职责、一个最容易被误用的地方（点出那个函数或字段的名字）、结论。',",
        ),
        (
            "    { what: '有行号', any: [':1', ':2', ':3', ':4', ':5', ':6', ':7', ':8', ':9', 'L1', 'L2', 'L3'] },",
            "    { what: '有汇总', any: ['综上', '汇总', '总结', '三段结论'] },",
        ),
    ],
    'bench/scenarios.mjs': [
        (
            "    '每份评审都要读相关源码并给出证据行号,最后汇总:三方在哪些点上一致、在哪些点上分歧。',",
            "    '每份评审都要读相关源码并点出实现所在的文件,最后汇总:三方在哪些点上一致、在哪些点上分歧。',",
        ),
        (
            "    { what: '引用了源码行号证据', needles: ['rounds.ts'] },",
            "    { what: '点到了实现所在的文件', needles: ['rounds.ts'] },",
        ),
        (
            "    '4. 报告:每个 bug 是什么、在哪个文件、改了哪一行、最后 runner 的完整输出。',",
            "    '4. 报告:每个 bug 是什么、在哪个文件、改成了什么、最后 runner 的完整输出。',",
        ),
    ],
    'bench/pubeval.mjs': [
        (
            "      '4. 报告:每个 bug 是什么、改了哪一行,加上 check.py 的完整最终输出。',",
            "      '4. 报告:每个 bug 是什么、改了哪个文件,加上 check.py 的完整最终输出。',",
        ),
    ],
}

for name, pairs in edits.items():
    path = pathlib.Path(name)
    text = path.read_text(encoding='utf-8')
    for old, new in pairs:
        if old not in text:
            print(f'{name}: MISS {old.strip()[:60]}')
            continue
        text = text.replace(old, new, 1)
    path.write_text(text, encoding='utf-8', newline='\n')
    print(f'{name}: updated')
