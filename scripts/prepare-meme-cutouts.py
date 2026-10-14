"""Convert individually generated cutouts to WebP, preserving their alpha.

Usage: python scripts/prepare-meme-cutouts.py .cache/meme-pose-image-sources.json
The source map is local generation provenance, not a generation API client.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
sources = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
assert len(sources) == 40 and len({item['id'] for item in sources}) == 40
report = []
preview = Image.new('RGB', (1600, 2800), '#171922')
draw = ImageDraw.Draw(preview)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
for i, item in enumerate(sources):
    assert item['id'].startswith('meme-') and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in item['id'])
    image = Image.open(item['source'])
    assert image.mode == 'RGBA', f"No alpha channel: {item['id']}"
    histogram = image.getchannel('A').histogram()
    transparent = histogram[0] / sum(histogram)
    assert transparent > .02 and sum(histogram[240:]) / sum(histogram) > .15, f"Invalid cutout alpha: {item['id']}"
    target = root / 'public' / 'pose-guides' / (item['id'] + '.webp')
    image.save(target, 'WEBP', quality=92, method=4)
    check = Image.open(target)
    assert check.mode == 'RGBA' and check.getchannel('A').histogram() == histogram, f"Alpha changed: {item['id']}"
    report.append({'id':item['id'], 'assetPath':'pose-guides/' + target.name, 'bytes':target.stat().st_size, 'transparentFraction':round(transparent,3)})
    thumb = image.copy()
    thumb.thumbnail((300, 300))
    x, y = (i % 5) * 320, (i // 5) * 350
    preview.paste(thumb, (x + (320-thumb.width)//2, y + (310-thumb.height)//2), thumb)
    draw.text((x+12, y+316), f"{i+1:02}. {item['id'][5:]}", fill='white', font=font)
    print(f"Prepared {i+1}/40: {item['id']}", flush=True)
preview_dir = root / 'docs' / 'assets'
preview_dir.mkdir(exist_ok=True)
preview.save(preview_dir / 'meme-pose-pack-preview.jpg', quality=92)
(root / '.cache' / 'meme-cutout-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
