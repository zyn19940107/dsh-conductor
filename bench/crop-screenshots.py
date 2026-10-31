"""
Crop the two screenshots down to the part worth putting in a README.

The captured pages carry the whole application chrome: the workspace sidebar
lists other conversations, and none of that belongs in a public repository.
"""

from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
DOCS = REPO / 'docs'

# (source, destination, box) — box is (left, top, right, bottom).
CROPS = [
    # The first turn of the run: the prompt, the model's plan in its thinking,
    # and the plan tool call it produced.
    (REPO / 'docs' / 'plan-turn.png', REPO / 'docs' / 'plan-turn.png', (455, 88, 1400, 520)),
    # The formation graph and its roster.
    (REPO / 'docs' / 'formation.png', REPO / 'docs' / 'formation.png', (292, 84, 1400, 812)),
]


def main() -> None:
    for source, destination, box in CROPS:
        image = Image.open(source)
        cropped = image.crop(box)
        cropped.save(destination)
        print(f'{destination.name}: {image.size} -> {cropped.size}')


if __name__ == '__main__':
    main()
