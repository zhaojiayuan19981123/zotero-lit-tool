# make-icns.py —— 从 icon.png 生成 macOS .icns 图标
import sys
from PIL import Image

src = r"C:\Users\zjy1998\WorkBuddy\2026-09-15-01-27-46\zotero-lit-tool\build\icon.png"
out = r"C:\Users\zjy1998\WorkBuddy\2026-09-15-01-27-46\zotero-lit-tool\build\icon.icns"

img = Image.open(src).convert("RGBA")
print("源图尺寸:", img.size)

# macOS icns 需要的尺寸集合
sizes = [16, 32, 64, 128, 256, 512, 1024]

# Pillow 的 ICNS 保存需要传入一个包含各尺寸图的列表（sizes 参数）
img.save(out, format="ICNS", append_images=[img.resize((s, s), Image.LANCZOS) for s in sizes])

import os
print("已生成:", out)
print("文件大小: %.1f KB" % (os.path.getsize(out) / 1024))
