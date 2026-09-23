# -*- coding: utf-8 -*-
"""
从设计稿生成全套应用图标。

输入：一张设计稿（PNG）。四周通常有大片留白；
      留白可能是**真透明**（带 alpha），也可能是**不透明白底**，两种都要能处理。
输出（全部落在 build/、public/、electron/）：
  build/icon.png      1024x1024  Electron / 通用
  build/icon.ico      Windows（多尺寸：16/24/32/48/64/128/256）
  build/icon.icns     macOS（多尺寸）
  build/icon-256.png  256x256 预览 / 安装器
  public/favicon.png  浏览器标签页与界面左上角 logo（64x64）
  electron/icon.png   运行时窗口/任务栏图标（256x256）

关键点：
1. 设计稿四周有大片留白，必须先**自动裁剪**到图形本身，否则图标会显得很小。
   - 设计稿带透明通道时，**只能以 alpha 为准**；用 convert("RGB") 会把透明背景
     读成白色，虽然包围盒碰巧还对，但后面合成时透明信息就彻底丢了。
2. 裁剪后要**补成正方形**，否则非等比缩放会把图标压扁。
3. 补白必须用**全透明**，不能填白色 —— 否则在深色任务栏 / 侧边栏上会是一个白方块。
4. 抠掉背景后要保留一点内边距，避免图形贴边（Windows 任务栏会显得很挤）。

历史坑（v1.16.2 修复）：square_crop 曾用 Image.new("RGBA", ..., (255,255,255,255))
加 canvas.paste(src, box, src) 合成，结果所有图标 alpha 恒为 255、背景是白的；
而且 paste 会把 alpha 通道也乘一遍，半透明边缘的 alpha 被平方（a²）出现暗边。
现在改为透明画布 + alpha_composite（source-over）。
"""
import os
import sys
from PIL import Image

# 设计稿：允许命令行覆盖，默认用最近给的那张
SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\desktop\icon-256.png"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
PUBLIC = os.path.join(ROOT, "public")
ELECTRON = os.path.join(ROOT, "electron")

# 判定「非背景」的阈值（仅用于不透明白底设计稿）：与白色的差异超过这个值就算图形
WHITE_TOL = 12
# 判定「非透明」的阈值：alpha 小于该值视为留白
ALPHA_TOL = 8
# 裁剪后四周额外留出的内边距（占最终边长的比例）
PAD_RATIO = 0.04


def has_alpha_content(img):
    """设计稿是否带真实透明通道（有全透明像素即有）。"""
    if img.mode not in ("RGBA", "LA", "PA", "P"):
        return False
    alpha = img.convert("RGBA").split()[3]
    return alpha.getextrema()[0] < 255


def content_bbox(img):
    """找出图形本身的包围盒，用于裁掉设计稿的大片留白。

    有透明通道 → 以 alpha 为准（唯一正确依据）；
    不透明白底 → 退回「与白色的差异」判定。
    """
    rgba = img.convert("RGBA")
    w, h = rgba.size

    if has_alpha_content(rgba):
        mask = rgba.split()[3].point(lambda v: 255 if v > ALPHA_TOL else 0)
        bbox = mask.getbbox()
        if bbox:
            return bbox

    rgb = rgba.convert("RGB")
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
    """按包围盒裁出**正方形**（取长边），再向外扩一圈透明内边距。"""
    x1, y1, x2, y2 = box
    side = max(x2 - x1, y2 - y1)
    # 以包围盒中心为基准补成正方形
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = side / 2
    pad = side * pad_ratio
    left, top = int(round(cx - half - pad)), int(round(cy - half - pad))
    right, bottom = int(round(cx + half + pad)), int(round(cy + half + pad))

    src = img.convert("RGBA")
    w, h = src.size

    # 目标区域完全落在源图内 → 直接裁，不经画布合成，零误差
    if left >= 0 and top >= 0 and right <= w and bottom <= h:
        return src.crop((left, top, right, bottom))

    # 需要外扩：用**全透明**画布
    canvas = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
    # ★ 必须用 alpha_composite（source-over），不能用 paste(..., mask=src)：
    #   paste 会把 alpha 通道也乘一遍 → 半透明边缘 alpha 变成 a²，出现暗边。
    canvas.alpha_composite(src, (-left, -top))
    return canvas


def check_transparent(path):
    """自检：产物必须是 RGBA，且四角真的透明（防止又退回白底）。

    返回 (ok, 描述)。
    """
    try:
        im = Image.open(path)
    except Exception as exc:
        return False, "无法读取: %s" % exc
    if im.mode != "RGBA":
        return False, "mode=%s（应为 RGBA）" % im.mode
    rgba = im.convert("RGBA")
    w, h = rgba.size
    lo, hi = rgba.split()[3].getextrema()
    corners = [rgba.getpixel(p)[3] for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    ok = lo == 0 and all(a == 0 for a in corners)
    return ok, "alpha=(%d,%d) 四角 alpha=%s" % (lo, hi, corners)


def main():
    if not os.path.exists(SRC):
        print("找不到源图:", SRC)
        return 1

    img = Image.open(SRC)
    print("源图:", SRC)
    print("  模式:", img.mode, "尺寸:", img.size)
    print("  含透明背景:", has_alpha_content(img))

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

    # 4) 浏览器标签页图标 + 界面左上角 logo（透明底才能贴合侧边栏）
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
    failed = []
    for f in written:
        ok, desc = (True, "—")
        if f.lower().endswith(".png"):
            ok, desc = check_transparent(f)
            if not ok:
                failed.append((f, desc))
        print("  %-46s %8.1f KB  %s" % (os.path.relpath(f, ROOT), os.path.getsize(f) / 1024, desc))

    if failed:
        # 背景必须是透明的 —— 一旦产物四角不透明，直接报错，不再静默发布白底图标
        print("\n✗ 以下产物背景不透明，疑似回退成白底：")
        for f, desc in failed:
            print("   ", os.path.relpath(f, ROOT), desc)
        return 2

    print("\n✓ 全部 PNG 产物均为 RGBA 且四角透明")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
