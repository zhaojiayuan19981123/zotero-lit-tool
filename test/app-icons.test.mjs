/**
 * 应用图标必须带**透明背景**。
 *
 * 背景：v1.16.1 及之前的图标全是「不透明白底」—— 画布被填成 (255,255,255,255)，
 * 而设计稿本身是透明背景，于是界面上（深色侧栏、任务栏、Dock）看到的是一块白方块。
 * 根因在 build/make-icons.py：content_bbox 用 convert("RGB") 丢掉 alpha，
 * square_crop 又填了不透明白底并用 paste(..., mask) 合成（alpha 被平方）。
 *
 * 这里不依赖 Pillow，直接读 PNG 字节做校验：只要不是 RGBA、或左上角像素不透明，
 * 就说明背景又变回白的了。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解析 PNG 头与像素数据（仅支持非隔行的 8bit 图，够用）。 */
function parsePng(buf, label) {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), `${label} 不是 PNG`);

  const idat = [];
  let off = 8;
  let header = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  assert.ok(header, `${label} 缺少 IHDR`);
  return { ...header, raw: inflateSync(Buffer.concat(idat)) };
}

/**
 * 取左上角像素的 alpha。
 *
 * 扫描行的第一个字节是 filter type，其后才是像素数据。对**第一行第一个像素**而言，
 * 五种 filter 的预测值都是 0（左邻、上邻、左上邻都不存在），所以 filtered === raw，
 * 无需还原即可直接读。这也意味着不用把整张图解完就能判断背景是否透明。
 */
function topLeftAlpha(png) {
  assert.equal(png.interlace, 0, '不支持隔行 PNG');
  assert.equal(png.bitDepth, 8, '期望 8bit 色深');
  // colorType 6 = RGBA，此时每像素 4 字节且第 4 个是 alpha
  assert.equal(png.colorType, 6, '图标必须是带 alpha 通道的 RGBA PNG');
  assert.ok(png.raw.length >= 5, '像素数据过短');
  return png.raw[1 + 3]; // 跳过首行 filter 字节
}

const pngIcons = {
  'build/icon.png': new URL('../build/icon.png', import.meta.url),
  'build/icon-256.png': new URL('../build/icon-256.png', import.meta.url),
  'electron/icon.png': new URL('../electron/icon.png', import.meta.url),
  'public/favicon.png': new URL('../public/favicon.png', import.meta.url),
};

for (const [name, url] of Object.entries(pngIcons)) {
  test(`${name} 背景透明（RGBA 且左上角 alpha=0）`, () => {
    const png = parsePng(fs.readFileSync(url), name);
    assert.equal(topLeftAlpha(png), 0, `${name} 左上角不透明 —— 背景又变成白色方块了`);
    assert.equal(png.width, png.height, `${name} 应为正方形，实际 ${png.width}x${png.height}`);
  });
}

test('界面左上角 logo 用的 favicon 是透明底（贴合深色侧栏）', () => {
  // index.html 里 .brand-logo-img 直接引用 favicon.png，深色侧栏 (#102e2a) 上不能出现白底
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="brand-logo-img"/);
  assert.match(html, /src="favicon\.png"/);
  const png = parsePng(fs.readFileSync(pngIcons['public/favicon.png']), 'favicon');
  assert.equal(topLeftAlpha(png), 0);
});

test('Windows .ico 每个尺寸帧都保留 alpha 且背景透明', () => {
  const buf = fs.readFileSync(new URL('../build/icon.ico', import.meta.url));
  assert.equal(buf.readUInt16LE(0), 0, 'ICONDIR.reserved 应为 0');
  assert.equal(buf.readUInt16LE(2), 1, '应为图标类型 (1)');
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 5, `图标尺寸数偏少：${count}`);

  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const width = buf[base] || 256; // 目录项里 0 表示 256
    const height = buf[base + 1] || 256;
    const imageOffset = buf.readUInt32LE(base + 12);
    const bytesInRes = buf.readUInt32LE(base + 8);
    sizes.push(width);

    if (buf.subarray(imageOffset, imageOffset + 8).equals(PNG_SIG)) {
      // Pillow 把每帧都存成内嵌 PNG —— 直接校验它是透明底的 RGBA
      const png = parsePng(buf.subarray(imageOffset, imageOffset + bytesInRes), `${width}px 帧`);
      assert.equal(png.width, width, `${width}px 帧宽不符`);
      assert.equal(height, png.height, `${width}px 帧高不符`);
      // 容差 32：16px 帧的透明内边距不足一个像素（0.04*16 ≈ 0.64px），
      // 降采样后四角会残留 alpha 1~2，属于正常；白底残留会是 255。
      assert.ok(
        topLeftAlpha(png) <= 32,
        `${width}px 帧背景不透明（alpha=${topLeftAlpha(png)}）—— 又变回白底了`,
      );
    } else {
      // 老式 BMP(DIB) 帧：必须 32 位 BGRA 才带 alpha
      const dibBitCount = buf.readUInt16LE(imageOffset + 14);
      assert.equal(dibBitCount, 32, `${width}px 帧不是 32 位带 alpha（bitCount=${dibBitCount}）`);
    }
  }
  assert.ok(sizes.includes(256), '缺少 256x256 尺寸（Windows 大图标视图会用）');
  assert.ok(sizes.includes(16), '缺少 16x16 尺寸（任务栏/文件列表会用）');
});

test('图标生成脚本保留透明背景（禁止回退成白底画布）', () => {
  const script = fs.readFileSync(new URL('../build/make-icons.py', import.meta.url), 'utf8');
  // 包围盒必须以 alpha 为准，不能用 convert("RGB") 走白底判定
  assert.match(script, /def has_alpha_content/);
  assert.match(script, /if has_alpha_content\(rgba\)/);
  // 外扩画布必须是全透明 + alpha_composite（paste 会把 alpha 平方）
  assert.match(script, /Image\.new\("RGBA", \([^)]*\), \(0, 0, 0, 0\)\)/);
  assert.match(script, /alpha_composite/);
  // 不允许再出现不透明白色画布
  assert.doesNotMatch(script, /Image\.new\("RGBA"[^\n]*\(255, 255, 255, 255\)/);
  // 生成后要自检四角透明，否则直接失败
  assert.match(script, /def check_transparent/);
  assert.match(script, /四角 alpha=/);
});
