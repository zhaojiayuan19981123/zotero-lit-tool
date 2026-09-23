# -*- coding: utf-8 -*-
"""
从设计稿生成全套应用图标。

输入：一张带大片留白的设计稿（PNG）。
输出（全部落在 build/ 与 public/）：
  build/icon.png      1024x1024  Electron / 通用
  build/icon.ico      Windows（多尺寸：16/24/32/48/64/128/256）
  build/icon.icns     macOS（多尺寸）
  public/favicon.png  浏览器标签页（64x64）
  electron/icon.png   运行时窗口/任务栏图标（256x256）

关键点：
1. 设计稿四周有大片白底，必须先**自动裁剪**到图形本身，否则图标会显得很小。
2. 裁剪后要**补成正方形**，否则非等比缩放会把图标压扁。
3. 保留一点内边距，避免图形贴边（Windows 任务栏会显得很挤）。
"""
import os
import sys
from PIL import Image

# 设计稿：允许命令行覆盖，默认用用户给的那张
SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\desktop\未标题-1.png"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
PUBLIC = os.path.join(ROOT, "public")
ELECTRON = os.path.join(ROOT, "electron")

# 判定「非背景」的阈值：像素与白色的差异超过这个值就算图形的一部分
WHITE_TOL = 12
# 裁剪后四周额外留出的内边距（占最终边长的比例）
PAD_RATIO = 0.04


def content_bbox(img):
    """找出非白像素的包围盒。用于裁掉设计稿的大片留白。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    min_x, min_y, max_x, max_y = w, h, -1, -1
    # 逐行扫描足够快（图标素材不大），且比 getbbox() 更可控
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if abs(r - 255) > WHITE_TOL or abs(g - 255) > WHITE_TOL or abs(b - 255) > WHITE_TOL:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < 0:
        return (0, 0, w, h)  # 整张都是白的，保底返回原图
    return (min_x, min_y, max_x + 1, max_y + 1)


def square_crop(img, box, pad_ratio=PAD_RATIO):
    """按包围盒裁出**正方形**（取长边），再向外扩一圈内边距。"""
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    side = max(w, h)
    # 以包围盒中心为基准补成正方形
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = side / 2
    pad = side * pad_ratio
    left, top = cx - half - pad, cy - half - pad
    right, bottom = cx + half + pad, cy + half + pad

    # 超出的部分用白色补齐（设计稿本身就是白底，衔接自然）
    canvas = Image.new("RGBA", (int(round(right - left)), int(round(bottom - top))), (255, 255, 255, 255))
    src = img.convert("RGBA")
    # 需要平移的量
    canvas.paste(src, (int(round(-left)), int(round(-top))), src)
    return canvas


def main():
    if not os.path.exists(SRC):
        print("找不到源图:", SRC)
        return 1

    img = Image.open(SRC).convert("RGBA")
    print("源图:", SRC)
    print("  尺寸:", img.size)

    box = content_bbox(img)
    print("  内容包围盒:", box, "→", (box[2] - box[0], box[3] - box[1]))

    squared = square_crop(img, box)
    print("  正方形裁剪后:", squared.size)

    base = squared.resize((1024, 1024), Image.LANCZOS)

    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(PUBLIC, exist_ok=True)
    os.makedirs(ELECTRON, exist_ok=True)

    written = []

    # 1) 通用 PNG（electron-builder 会用它生成各平台图标）
    p = os.path.join(BUILD, "icon.png")
    base.save(p, format="PNG")
    written.append(p)

    # 2) Windows .ico —— 多尺寸，小尺寸下任务栏/文件列表才清晰
    p = os.path.join(BUILD, "icon.ico")
    base.save(p, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    written.append(p)

    # 3) macOS .icns —— Pillow 会从一个足够大的源图生成标准尺寸集合
    p = os.path.join(BUILD, "icon.icns")
    try:
        base.save(p, format="ICNS")
        written.append(p)
    except Exception as exc:  # ICNS 写入失败不该阻断其他产物
        print("  ! 生成 .icns 失败:", exc)

    # 4) 浏览器标签页图标
    p = os.path.join(PUBLIC, "favicon.png")
    base.resize((64, 64), Image.LANCZOS).save(p, format="PNG")
    written.append(p)

    # 5) Electron 运行时图标（窗口 / 任务栏 / 通知）
    p = os.path.join(ELECTRON, "icon.png")
    base.resize((256, 256), Image.LANCZOS).save(p, format="PNG")
    written.append(p)

    # 6) 安装器用的大图（NSIS 侧边栏等场景可能引用）
    p = os.path.join(BUILD, "icon-256.png")
    base.resize((256, 256), Image.LANCZOS).save(p, format="PNG")
    written.append(p)

    print("已生成:")
    for f in written:
        print("  %-46s %8.1f KB" % (os.path.relpath(f, ROOT), os.path.getsize(f) / 1024))

    # 顺便刷新一下生产用的 make-icns.py，避免它继续指向过期路径
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
