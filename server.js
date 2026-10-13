import express from "express";
import archiver from "archiver";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import pngToIco from "png-to-ico";
import { MAX_IMAGE_BYTES, imageDataBuffer, normalizeImage, normalizeImageDataUrl, parseBuildOptions } from './build-options.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind Cloudflare tunnel the socket IP is localhost; the real client IP
// arrives in CF-Connecting-IP / X-Forwarded-For. Trust the proxy so we can
// rate-limit per real client.
app.set("trust proxy", true);
// Allow base64 uploads for both the app icon and the optional splash logo.
app.use(express.json({ limit: "16mb" }));
app.use(express.static(join(__dirname, "public"), {
  setHeaders(res, path) {
    if (/\.(html|js)$/.test(path)) res.setHeader('Cache-Control', 'no-store');
  },
}));

// Build job queue 
const jobs = new Map();            // id -> job
const queue = [];                  // ids waiting to build
let working = false;               // a build is currently running
const MAX_QUEUE = 20;
const JOB_TTL_MS = 20 * 60 * 1000; // keep a finished job downloadable this long

function enqueue(job) {
  jobs.set(job.id, job);
  queue.push(job.id);
  processQueue();
}

async function processQueue() {
  if (working) return;
  const id = queue.shift();
  if (id === undefined) return;
  const job = jobs.get(id);
  if (!job) return processQueue();
  working = true;
  job.status = "building";
  try {
    job.result = await runBuild(job);
    job.status = "done";
  } catch (e) {
    console.error("[build] failed:", e);
    job.error = "Build gagal. Coba lagi atau periksa URL.";
    job.status = "error";
    cleanup(job.work);
  } finally {
    job.finishedAt = Date.now();
    working = false;
    processQueue();
  }
}

// Sweep finished/stale jobs so temp dirs and the map don't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const done = job.status === "done" || job.status === "error";
    const ref = job.finishedAt || job.createdAt;
    if ((done && now - ref > JOB_TTL_MS) || now - job.createdAt > 60 * 60 * 1000) {
      cleanup(job.work);
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

const NATIVEFIER_PLATFORM = { windows: "windows", linux: "linux", mac: "osx" };

// Optional shared secret. If ACCESS_TOKEN is set, /api/build requires it via
// the `x-access-token` header or `Authorization: Bearer <token>`. Recommended
// whenever the server is exposed publicly.
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
// How long a single build may run before we kill it (ms).
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 8 * 60 * 1000);

function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    "unknown"
  );
}

// --- Simple in-memory sliding-window rate limiter (per IP) ---------------
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = Number(process.env.RATE_MAX || 10); // builds per window per IP
const hits = new Map(); // ip -> number[] (timestamps)
function rateLimited(ip, max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}
// Periodically drop empty buckets so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, BUILD_TIMEOUT_MS);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

// Resolve a dependency's CLI entry so we can run it with `node <entry>` and
// shell:false. Going through `npx` + shell on Windows concatenates argv without
// quoting, which silently mangles any value containing a space (DEP0190).
async function binEntry(pkg) {
  const root = join(__dirname, "node_modules", pkg);
  const pj = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const rel = typeof pj.bin === "string" ? pj.bin : pj.bin[pkg];
  return join(root, rel);
}

function safeName(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]/gi, "-") || "webapp";
  } catch {
    return "webapp";
  }
}

const slug = (s) => s.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "webapp";
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const androidString = (s) => xmlEscape(JSON.stringify(s));

// Strip control chars, collapse whitespace, and — crucially — drop any leading
// "-" so the value can never be interpreted as a CLI flag by nativefier
// (argument injection). Also bound the length.
function sanitizeName(s) {
  return String(s)
    .replace(/[\u0000-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-\s]+/, "")
    .trim()
    .slice(0, 60);
}

// --- SSRF protection -----------------------------------------------------
function isPrivateIp(ip) {
  // Normalize IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 0) return true;                         // 0.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 169 && b === 254) return true;         // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase();
    if (lc === "::1") return true;                   // loopback
    if (lc === "::") return true;
    if (lc.startsWith("fe80")) return true;          // link-local
    if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // unique local fc00::/7
    return false;
  }
  return true; // unknown format -> treat as unsafe
}

// Resolve the hostname and reject if it points anywhere private/internal.
async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL tidak valid");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Hanya http/https yang didukung");
  }
  const host = u.hostname;
  if (host.toLowerCase() === "localhost") throw new Error("Alamat internal tidak diizinkan");
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new Error("Domain tidak dapat di-resolve");
    }
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("Alamat internal tidak diizinkan");
  }
  return u;
}

async function fetchTitle(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    const m = (await r.text()).match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? sanitizeName(m[1]) : null;
  } catch {
    return null;
  }
}

async function fetchIconResource(raw, maxBytes, signal, truncate = false) {
  let url = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Web2App/1.0)',
        'Cache-Control': 'no-cache', Pragma: 'no-cache',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    if (!response.ok || (!truncate && Number(response.headers.get('content-length')) > maxBytes)) {
      await response.body?.cancel();
      throw new Error('Favicon tidak tersedia atau terlalu besar.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      if (size + chunk.length > maxBytes) {
        if (!truncate) throw new Error('Favicon terlalu besar.');
        chunks.push(chunk.subarray(0, maxBytes - size));
        break;
      }
      size += chunk.length;
      chunks.push(chunk);
    }
    return { url, buffer: Buffer.concat(chunks) };
  }
  throw new Error('Terlalu banyak redirect favicon.');
}

async function siteIcon(siteUrl) {
  const signal = AbortSignal.timeout(15000);
  const candidates = [];
  let pageUrl = siteUrl;
  try {
    const page = await fetchIconResource(siteUrl, 512 * 1024, signal, true);
    pageUrl = page.url;
    const html = page.buffer.toString('utf8');
    const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(match => [match[1].toLowerCase(), (match[2] ?? match[3] ?? match[4]).replace(/&amp;/gi, '&')]));
    const base = attributes(html.match(/<base\b[^>]*>/i)?.[0] || '').href;
    const baseUrl = base ? new URL(base, pageUrl).href : pageUrl;
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const attrs = attributes(tag);
      if (attrs.href && /(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)/i.test(attrs.rel || '')) {
        candidates.push(new URL(attrs.href, baseUrl).href);
        if (candidates.length === 6) break;
      }
    }
  } catch {}
  candidates.push(new URL('/favicon.ico', pageUrl).href);
  for (const candidate of new Set(candidates)) {
    if (signal.aborted) break;
    try {
      const buffer = candidate.startsWith('data:') ? imageDataBuffer(candidate)
        : (await fetchIconResource(candidate, MAX_IMAGE_BYTES, signal)).buffer;
      return { buffer: await normalizeImage(buffer), source: 'site' };
    } catch {}
  }
  console.warn('[icon] Favicon situs tidak ditemukan, memakai ikon bawaan.');
  const buffer = await normalizeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="48" fill="#ffe253"/><g fill="none" stroke="#202020" stroke-width="10"><circle cx="128" cy="128" r="80"/><ellipse cx="128" cy="128" rx="36" ry="80"/><path d="M48 128h160M62 84h132M62 172h132"/></g></svg>'));
  return { buffer, source: 'default' };
}

async function resolveIcon(work, dataUrl, siteUrl) {
  const buffer = dataUrl != null && dataUrl !== ''
    ? await normalizeImage(imageDataBuffer(dataUrl)) : (await siteIcon(siteUrl)).buffer;
  const path = join(work, 'icon.png');
  await writeFile(path, buffer);
  return path;
}

// Windows .exe needs a real .ico. nativefier only converts PNG->ICO when
// ImageMagick is available (not on Windows hosts), so it silently keeps the
// default Electron icon. Convert here instead.
async function toIco(work, pngPath) {
  try {
    const p = join(work, "icon.ico");
    await writeFile(p, await pngToIco(pngPath));
    return p;
  } catch (e) {
    console.warn("[icon] PNG->ICO gagal, memakai ikon bawaan:", e.message);
    return null;
  }
}

function authorize(req, res, next) {
  if (ACCESS_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const token = req.headers["x-access-token"] || bearer;
    if (token !== ACCESS_TOKEN) return res.status(401).json({ error: "Tidak diizinkan" });
  }
  next();
}

app.post('/api/images/normalize', authorize, async (req, res) => {
  try {
    res.json({ dataUrl: await normalizeImageDataUrl(req.body?.dataUrl) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/icons/preview', authorize, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (rateLimited(`icon:${clientIp(req)}`, 60, 60000)) {
    return res.status(429).json({ error: 'Terlalu banyak pratinjau ikon. Coba lagi sebentar.' });
  }
  try {
    const url = await assertPublicUrl(req.body?.url);
    const icon = await siteIcon(url.href);
    res.json({ dataUrl: `data:image/png;base64,${icon.buffer.toString('base64')}`, source: icon.source });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/build", authorize, async (req, res) => {
  // --- rate limit ---
  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ error: "Terlalu banyak permintaan, coba lagi nanti" });

  const { url, platform, name: rawName, singleFile } = req.body || {};
  let { iconDataUrl } = req.body || {};

  if (!["windows", "linux", "mac", "apk"].includes(platform)) {
    return res.status(400).json({ error: "platform tidak dikenal" });
  }
  let options;
  try {
    options = parseBuildOptions(req.body, platform);
    if (iconDataUrl != null && iconDataUrl !== '') iconDataUrl = await normalizeImageDataUrl(iconDataUrl);
    if (options.splash?.imageDataUrl) options.splash.imageDataUrl = await normalizeImageDataUrl(options.splash.imageDataUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // Validate + block internal/SSRF targets before doing any work.
  let target;
  try {
    target = await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || "URL tidak valid") });
  }
  if (queue.length >= MAX_QUEUE) {
    return res.status(503).json({ error: "Antrian penuh, coba lagi nanti" });
  }

  // Enqueue and return immediately — the heavy work happens in the queue worker,
  // so this response lands well within any proxy's header timeout.
  const work = await mkdtemp(join(tmpdir(), "h2e-"));
  const job = {
    id: randomUUID(),
    status: "queued",
    createdAt: Date.now(),
    work,
    params: { platform, safeUrl: target.href, rawName, iconDataUrl, singleFile, options },
  };
  enqueue(job);
  res.status(202).json({ id: job.id });
});

app.get("/api/build/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan atau kedaluwarsa" });
  const position = job.status === "queued" ? queue.indexOf(job.id) + 1 : 0;
  res.json({ status: job.status, position, error: job.error, name: job.result?.name });
});

app.get("/api/build/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan atau kedaluwarsa" });
  if (job.status !== "done") return res.status(409).json({ error: "Build belum selesai" });
  // The unguessable UUID is the access control here — a link navigation can't
  // carry the ACCESS_TOKEN header, and the id only exists after an authed POST.
  res.download(job.result.file, job.result.name, (err) => {
    if (!err) { cleanup(job.work); jobs.delete(job.id); } // one-shot; sweeper covers aborts
  });
});

// The actual build. Returns { file, name } for the queue worker to serve later.
async function runBuild(job) {
  const { platform, safeUrl, rawName, iconDataUrl, singleFile, options } = job.params;
  const work = job.work;
  // sanitizeName guarantees the display name can never start with "-"
  // (argument injection) and is bounded/clean before hitting the CLI.
  const displayName =
    sanitizeName(rawName || "") ||
    (await fetchTitle(safeUrl)) ||
    safeName(safeUrl);
  const fileBase = slug(displayName);
  // Always resolve an icon ourselves: user upload if given, else the site
  // favicon. nativefier's own auto-detect is unreliable, so we pass --icon.
  let iconPath = await resolveIcon(work, iconDataUrl, safeUrl);
  const splashIconPath = iconPath;
  if (iconPath && platform === "windows") iconPath = await toIco(work, iconPath);

  if (platform === "apk") {
    const apk = await buildApk(work, safeUrl, displayName, iconPath, options);
    return { file: apk, name: `${fileBase}.apk` };
  }

  // desktop: nativefier -> folder
  const out = join(work, "out");
  // Positionals precede --inject because its array parser consumes trailing paths.
  const args = [safeUrl, out, "--name", displayName, "--platform", NATIVEFIER_PLATFORM[platform], "--app-version", options.versionName];
  // ponytail: windows gets a converted .ico; linux takes PNG directly.
  // macOS wants .icns and we don't convert that — needs a Mac anyway.
  if (iconPath) args.push("--icon", iconPath);
  if (options.splash) {
    const injection = join(work, 'splash.js');
    const splash = { ...options.splash, title: options.splash.title || displayName };
    if (!splash.imageDataUrl && splashIconPath) {
      splash.imageDataUrl = `data:image/png;base64,${(await readFile(splashIconPath)).toString('base64')}`;
    }
    const renderer = await readFile(join(__dirname, 'public/splash.js'), 'utf8');
    // shortcut: desktop splash starts at DOM ready; use a separate window for a splash before network loading.
    await writeFile(injection, `${renderer}\n(() => {
      try {
        if (sessionStorage.getItem('web2app:splash')) return;
        sessionStorage.setItem('web2app:splash', '1');
      } catch {}
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;';
      document.documentElement.append(host);
      Web2AppSplash(host.attachShadow({mode:'open'}), ${JSON.stringify(splash)}, () => host.remove());
    })();`);
    args.push('--inject', injection);
  }
  await run(process.execPath, [await binEntry("nativefier"), ...args], { shell: false });
  const built = join(out, (await readdir(out))[0]); // nativefier makes one subfolder
  const appDir = platform === 'mac'
    ? join(built, (await readdir(built)).find(file => file.endsWith('.app')), 'Contents/Resources/app')
    : join(built, 'resources/app');
  const appPackagePath = join(appDir, 'package.json');
  const appPackage = JSON.parse(await readFile(appPackagePath, 'utf8'));
  appPackage.version = options.versionName;
  await writeFile(appPackagePath, JSON.stringify(appPackage, null, 2));

  if (platform === "windows" && singleFile) {
    const exe = await toPortableExe(work, built, displayName, fileBase, iconPath, options.versionName);
    // level 0: the portable exe is already 7z-compressed inside, so deflating
    // it again costs CPU for ~nothing. The zip is just a delivery wrapper —
    // browsers and AV are far happier with a .zip than a bare .exe.
    const zipPath = join(work, `${fileBase}-portable.zip`);
    await zipToFile(zipPath, (z) => z.file(exe, { name: `${displayName}.exe` }), 0);
    return { file: zipPath, name: `${fileBase}-portable.zip` };
  }
  const zipPath = join(work, `${fileBase}-${platform}.zip`);
  await zipToFile(zipPath, (z) => z.directory(built, fileBase), 9);
  return { file: zipPath, name: `${fileBase}-${platform}.zip` };
}

// Build a zip on disk (not streamed to a response) so the queue worker can hand
// the file to a later download request.
function zipToFile(outPath, addFn, level) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const zip = archiver("zip", { zlib: { level } });
    output.on("close", () => resolve(outPath));
    output.on("error", reject);
    zip.on("error", reject);
    zip.pipe(output);
    addFn(zip);
    zip.finalize();
  });
}

// Wrap the packaged Electron folder (exe + dlls + .pak) into a single
// self-contained .exe. electron-builder's `portable` target unpacks to a temp
// dir at launch, so the user only ever handles one file.
async function toPortableExe(work, builtDir, displayName, fileBase, iconPath, versionName) {
  // electron-builder wants a project dir with a package.json to read name/version from
  await writeFile(join(work, "package.json"), JSON.stringify({ name: fileBase, version: versionName }));
  // With --prepackaged there is no local electron dep to infer the version from,
  // so read it out of the packaged app (electron-packager drops a `version` file).
  const electronVersion = (await readFile(join(builtDir, "version"), "utf8").catch(() => "")).trim();
  const cfg = {
    appId: `com.html2exe.${fileBase.replace(/-/g, "") || "app"}`,
    productName: displayName,
    ...(electronVersion ? { electronVersion } : {}),
    directories: { output: "dist" },
    win: { target: "portable", ...(iconPath && iconPath.endsWith(".ico") ? { icon: iconPath } : {}) },
    portable: { artifactName: "${productName}.exe" },
  };
  await writeFile(join(work, "eb.json"), JSON.stringify(cfg));
  await run(process.execPath, [
    await binEntry("electron-builder"),
    "--prepackaged", builtDir,
    "--win", "portable",
    "--projectDir", work,
    "--config", join(work, "eb.json"),
  ], { shell: false });
  const dist = join(work, "dist");
  const exe = (await readdir(dist)).find((f) => f.toLowerCase().endsWith(".exe"));
  if (!exe) throw new Error("portable exe tidak ditemukan");
  return join(dist, exe);
}

// Gradle must RUN on a JDK, not just have one installed: AGP takes its compiler
// from the JVM running Gradle. On a JRE the build gets ~20 tasks in and dies
// with "does not provide the required capabilities: [JAVA_COMPILER]", which
// points at the JVM rather than at the missing package. Fail early instead.
async function assertJdk(javaBin) {
  // Ask the JVM where it actually lives, then look for javac inside THAT
  // install. Checking `javac` on PATH is not enough: a machine can have
  // javac 17 on PATH while `java` resolves to a separate JRE 21, and Gradle
  // only ever uses the compiler from the JVM it is running on.
  let home = "";
  try {
    home = await new Promise((resolve, reject) => {
      const p = spawn(javaBin, ["-XshowSettings:properties", "-version"], { shell: false });
      let buf = "";
      p.stdout.on("data", (d) => (buf += d));
      p.stderr.on("data", (d) => (buf += d)); // -XshowSettings writes to stderr
      p.on("error", reject);
      p.on("close", () => {
        const m = buf.match(/java\.home\s*=\s*(.+)/);
        resolve(m ? m[1].trim() : "");
      });
    });
  } catch {
    throw new Error(`Java tidak ditemukan: ${javaBin}. Set JAVA_HOME ke direktori JDK.`);
  }
  const javac = join(home, "bin", process.platform === "win32" ? "javac.exe" : "javac");
  if (!home || !existsSync(javac)) {
    throw new Error(
      `Gradle akan berjalan di JVM "${home || javaBin}" yang tidak punya javac (itu JRE). ` +
      "Set JAVA_HOME ke direktori JDK, mis. /usr/lib/jvm/java-17-openjdk-amd64. " +
      "javac dari JDK lain yang ada di PATH tidak dipakai Gradle."
    );
  }
  return home;
}

async function prepareAndroidProject(work, url, displayName, iconPath, options) {
  const { packageName, versionName, versionCode, splash } = options;
  const proj = join(work, "android");
  await cp(join(__dirname, "android-template"), proj, { recursive: true });
  // inject name + URL into strings.xml placeholders
  const strings = join(proj, "app/src/main/res/values/strings.xml");
  const xml = (await readFile(strings, "utf8"))
    .replace("__TARGET_URL__", () => androidString(url))
    .replace("__APP_NAME__", () => androidString(displayName));
  await writeFile(strings, xml);
  await writeFile(join(proj, "app/src/main/res/values/splash-loader.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="splash_loader" formatted="false">${androidString(splash?.loader ?? 'none')}</string>
</resources>
`);
  await writeFile(join(proj, "app/src/main/res/values/splash.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <bool name="splash_enabled">${Boolean(splash)}</bool>
    <integer name="splash_duration">${splash?.duration ?? 2000}</integer>
    <string name="splash_animation" formatted="false">${androidString(splash?.animation ?? 'none')}</string>
    <string name="splash_title" formatted="false">${androidString(splash?.title || displayName)}</string>
    <string name="splash_subtitle" formatted="false">${androidString(splash?.subtitle ?? '')}</string>
    <color name="splash_background">${splash?.background ?? '#ffe253'}</color>
    <color name="splash_foreground">${splash?.foreground ?? '#202020'}</color>
</resources>
`);
  // custom package name: patch build.gradle, then move MainActivity.java
  // into the java/ folder that matches the package (Java requires it)
  const gradlePath = join(proj, "app/build.gradle");
  await writeFile(gradlePath, (await readFile(gradlePath, "utf8"))
    .replaceAll("__PACKAGE_NAME__", packageName)
    .replace("__VERSION_NAME__", versionName)
    .replace("__VERSION_CODE__", String(versionCode)));
  const javaRoot = join(proj, "app/src/main/java");
  const oldDir = join(javaRoot, "com/html2exe/webapp");
  const mainActivity = (await readFile(join(oldDir, "MainActivity.java"), "utf8")).replace("__PACKAGE_NAME__", packageName);
  await rm(join(javaRoot, "com"), { recursive: true, force: true });
  const newDir = join(javaRoot, ...packageName.split("."));
  await mkdir(newDir, { recursive: true });
  await writeFile(join(newDir, "MainActivity.java"), mainActivity);
  // Both uploads and website favicons arrive here as PNG.
  const manifest = join(proj, "app/src/main/AndroidManifest.xml");
  let iconAttr = "";
  if (iconPath) {
    const drawable = join(proj, "app/src/main/res/drawable");
    await mkdir(drawable, { recursive: true });
    await cp(iconPath, join(drawable, "app_icon.png"));
    iconAttr = 'android:icon="@drawable/app_icon"';
  }
  if (splash?.imageDataUrl) {
    const drawable = join(proj, "app/src/main/res/drawable");
    await mkdir(drawable, { recursive: true });
    await writeFile(join(drawable, 'splash_logo.png'), await normalizeImage(imageDataBuffer(splash.imageDataUrl)));
  }
  await writeFile(manifest, (await readFile(manifest, "utf8")).replace("__ICON_ATTR__", iconAttr));
  return proj;
}

async function buildApk(work, url, displayName, iconPath, options) {
  const proj = await prepareAndroidProject(work, url, displayName, iconPath, options);
  // Run the wrapper jar through java directly instead of the gradlew/gradlew.bat
  // scripts. Same thing those scripts do, but immune to the three ways they
  // break: missing +x after a Windows->Linux copy, CRLF line endings, and the
  // empty-%CLASSPATH% bug in Gradle 8.14's .bat launcher.
  // Still needs the Android SDK — ANDROID_HOME or a local.properties.
  const wrapperJar = join(proj, "gradle", "wrapper", "gradle-wrapper.jar");
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
  const jdkHome = await assertJdk(java);
  await run(java, [
    "-Dorg.gradle.appname=gradlew",
    "-jar", wrapperJar,
    // Pin the JVM Gradle compiles with, and stop it scanning /usr/lib/jvm for
    // others: a JRE-only java-21 sitting there gets picked as a "toolchain
    // installation" and fails with "does not provide ... [JAVA_COMPILER]",
    // even when JAVA_HOME already points at a good JDK.
    `-Dorg.gradle.java.home=${jdkHome}`,
    "-Dorg.gradle.java.installations.auto-detect=false",
    "assembleDebug",
  ], {
    cwd: proj,
    shell: false,
    stdio: "inherit",
  });
  return join(proj, "app/build/outputs/apk/debug/app-debug.apk");
}

function cleanup(dir) {
  rm(dir, { recursive: true, force: true }).catch(() => {});
}

app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Data terlalu besar. Setiap gambar maksimal 5 MB.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Data JSON tidak valid.' });
  next(error);
});

const PORT = process.env.PORT || 4444;
export { app, prepareAndroidProject, resolveIcon, toIco };
const serverPath = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === serverPath;
const isPm2Run = process.env.pm_exec_path && resolve(process.env.pm_exec_path) === serverPath;

if (isDirectRun || isPm2Run) app.listen(PORT, () => {
  console.log(`html2exe → http://localhost:${PORT}`);
  if (!ACCESS_TOKEN) console.warn("[warn] ACCESS_TOKEN kosong — endpoint /api/build terbuka. Set ACCESS_TOKEN untuk membatasi akses.");
});
