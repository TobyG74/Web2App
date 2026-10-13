const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null').split(' '));
export const SPLASH_ANIMATIONS = ['none', 'fade', 'zoom', 'slide-up', 'bounce', 'rotate'];

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
    if (typeof imageDataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)) {
      throw new Error('Logo splash harus berupa gambar PNG atau JPEG.');
    }
    const buffer = Buffer.from(imageDataUrl.split(',')[1], 'base64');
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (buffer.length > 1024 * 1024 || (imageDataUrl.startsWith('data:image/png;') ? !png : !jpeg)) {
      throw new Error('Logo splash tidak valid atau lebih besar dari 1 MB.');
    }
  }
  options.splash = {
    animation, duration, background, foreground, imageDataUrl,
    title: text(splash.title, '', 60, 'Judul splash'),
    subtitle: text(splash.subtitle, '', 100, 'Subjudul splash'),
  };
  return options;
}
