import sharp from 'sharp';
import ico from 'sharp-ico';
import bmp from 'sharp-bmp';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function imageDataBuffer(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) {
    throw new Error('Gambar maksimal 5 MB.');
  }
  const match = dataUrl.match(/^data:(?:image\/[\w.+-]+|application\/octet-stream)?;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error('Data gambar tidak valid.');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Gambar maksimal 5 MB.');
  return buffer;
}

function checkDimensions(width, height) {
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new Error('Resolusi gambar maksimal 16 megapiksel.');
  }
}

function largestIcoImage(buffer, options) {
  const count = buffer.readUInt16LE(4);
  if (!count || buffer.length < 6 + count * 16) throw new Error('ICO tidak valid.');
  let best = null;
  for (let i = 0; i < count; i++) {
    const entry = buffer.subarray(6 + i * 16, 22 + i * 16);
    const size = entry.readUInt32LE(8), offset = entry.readUInt32LE(12);
    if (offset < 6 + count * 16 || size < 40 || offset + size > buffer.length) continue;
    const data = buffer.subarray(offset, offset + size);
    const png = data.subarray(0, 8).equals(PNG_SIGNATURE);
    const width = png ? data.readUInt32BE(16) : data.readInt32LE(4);
    const height = png ? data.readUInt32BE(20) : data.readInt32LE(8) / 2;
    if (width !== (entry[0] || 256) || height !== (entry[1] || 256)) continue;
    if (!best || width * height > best.area) best = { entry, data, area: width * height };
  }
  if (!best) throw new Error('ICO tidak valid.');
  // Decode only the largest frame, so a many-frame ICO cannot multiply memory use.
  const single = Buffer.concat([buffer.subarray(0, 6), best.entry, best.data]);
  single.writeUInt16LE(1, 4);
  single.writeUInt32LE(22, 18);
  return ico.sharpsFromIco(single, options)[0];
}

export async function normalizeImage(buffer) {
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Gambar maksimal 5 MB.');
  const options = { limitInputPixels: MAX_PIXELS, failOn: 'error' };
  try {
    let image;
    if (buffer.length >= 6 && buffer.readUInt32LE(0) === 0x00010000) {
      image = largestIcoImage(buffer, options);
    } else if (buffer.subarray(0, 2).toString() === 'BM') {
      if (buffer.length < 54 || buffer.readUInt32LE(14) < 40) throw new Error('BMP tidak valid.');
      checkDimensions(buffer.readUInt32LE(18), Math.abs(buffer.readInt32LE(22)));
      const paletteSize = buffer.readUInt32LE(46);
      if (paletteSize > 256) throw new Error('Palet BMP tidak valid.');
      image = bmp.sharpFromBmp(buffer, options);
    } else {
      image = sharp(buffer, options);
    }
    return await image.autoOrient().resize(256, 256, {
      fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png().timeout({ seconds: 5 }).toBuffer();
  } catch {
    throw new Error('Gambar tidak dapat dibaca atau resolusinya melebihi 16 megapiksel. Gunakan PNG, JPG, WebP, SVG, GIF, BMP, TIFF, AVIF, atau ICO.');
  }
}

export async function normalizeImageDataUrl(dataUrl) {
  return `data:image/png;base64,${(await normalizeImage(imageDataBuffer(dataUrl))).toString('base64')}`;
}

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null').split(' '));
export const SPLASH_ANIMATIONS = ['none', 'fade', 'zoom', 'slide-up', 'bounce', 'rotate', 'pulse', 'flip'];
export const SPLASH_LOADERS = ['none', 'spinner', 'dots', 'bars', 'ring'];

function text(value, fallback, max, label) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} tidak valid (maksimal ${max} karakter).`);
  }
  return value.trim() || fallback;
}

export function parseBuildOptions(body, platform) {
  const versionName = text(body.versionName, platform === 'apk' ? '1.0' : '1.0.0', 40, 'Versi aplikasi');
  if (platform === 'apk' ? !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(versionName) : !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(versionName)) {
    throw new Error(platform === 'apk' ? 'Versi hanya boleh berisi huruf, angka, titik, +, - dan _.' : 'Versi desktop harus seperti 1.2.3.');
  }
  if (platform === 'windows' && versionName.split('.').some(part => Number(part) > 65535)) {
    throw new Error('Setiap bagian versi Windows maksimal 65535.');
  }
  const packageName = platform === 'apk' ? text(body.packageName, 'com.html2exe.webapp', 150, 'Package name') : 'com.html2exe.webapp';
  if (!PACKAGE_RE.test(packageName) || packageName.split('.').some(part => JAVA_KEYWORDS.has(part))) {
    throw new Error('Package name tidak valid, contoh: com.perusahaanmu.namaapp.');
  }
  const rawCode = platform === 'apk' ? body.versionCode : undefined;
  const versionCode = rawCode == null || rawCode === '' ? 1 : Number(rawCode);
  if ((rawCode != null && !['string', 'number'].includes(typeof rawCode)) || !Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error('Version code harus bilangan bulat antara 1 dan 2100000000.');
  }
  const options = { versionName, versionCode, packageName, splash: null };
  if (body.splash == null) return options;
  if (typeof body.splash !== 'object' || Array.isArray(body.splash) || typeof body.splash.enabled !== 'boolean') {
    throw new Error('Pengaturan splash screen tidak valid.');
  }
  if (!body.splash.enabled) return options;
  const splash = body.splash;
  const animation = splash.animation ?? 'fade';
  if (!SPLASH_ANIMATIONS.includes(animation)) throw new Error('Animasi splash tidak dikenal.');
  const loader = splash.loader ?? 'none';
  if (!SPLASH_LOADERS.includes(loader)) throw new Error('Animasi loading splash tidak dikenal.');
  const duration = splash.duration ?? 2000;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 500 || duration > 5000) {
    throw new Error('Durasi splash harus antara 500 dan 5000 milidetik.');
  }
  const background = splash.background ?? '#ffe253';
  const foreground = splash.foreground ?? '#202020';
  if (![background, foreground].every(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) {
    throw new Error('Warna splash harus berupa kode hex, contoh #ffe253.');
  }
  const luminance = hex => hex.slice(1).match(/../g)
    .map(c => parseInt(c, 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const colors = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
  if ((colors[0] + .05) / (colors[1] + .05) < 4.5) {
    throw new Error('Warna teks splash harus memiliki kontras minimal 4.5:1 terhadap latar.');
  }
  let imageDataUrl = splash.imageDataUrl ?? null;
  if (imageDataUrl !== null) {
    imageDataBuffer(imageDataUrl);
  }
  options.splash = {
    animation, loader, duration, background, foreground, imageDataUrl,
    title: text(splash.title, '', 60, 'Judul splash'),
    subtitle: text(splash.subtitle, '', 100, 'Subjudul splash'),
  };
  return options;
}
