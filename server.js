import express from "express";
import archiver from "archiver";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind Cloudflare tunnel the socket IP is localhost; the real client IP
// arrives in CF-Connecting-IP / X-Forwarded-For. Trust the proxy so we can
// rate-limit per real client.
app.set("trust proxy", true);
// Cap the JSON body: an uploaded icon (base64 data URL) can be large, but not
// unbounded. 2mb is plenty for a PNG icon and stops memory-abuse posts.
app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(__dirname, "public")));

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
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
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

const DEFAULT_PACKAGE = "com.html2exe.webapp";
// Java package rules: dot-separated identifiers, each starting with a letter.
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

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

async function resolveIcon(work, dataUrl, siteUrl) {
  let buf = null;
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
    buf = Buffer.from(dataUrl.split(",")[1] || "", "base64");
  } else if (siteUrl) {
    try {
      const host = new URL(siteUrl).hostname;
      const r = await fetch(`https://www.google.com/s2/favicons?sz=256&domain=${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(5000) });
      buf = Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  if (!buf || !buf.length) return null;
  // Reject oversized icons (5mb) so a giant data URL can't fill the disk.
  if (buf.length > 5 * 1024 * 1024) return null;
  const p = join(work, "icon.png");
  await writeFile(p, buf);
  return p;
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
    console.warn("[icon] PNG->ICO gagal, pakai PNG apa adanya:", e.message);
    return pngPath;
  }
}

app.post("/api/build", async (req, res) => {
  // --- auth ---
  if (ACCESS_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const token = req.headers["x-access-token"] || bearer;
    if (token !== ACCESS_TOKEN) return res.status(401).json({ error: "Tidak diizinkan" });
  }
  // --- rate limit ---
  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ error: "Terlalu banyak permintaan, coba lagi nanti" });

  const { url, platform, name: rawName, iconDataUrl, packageName: rawPackage, singleFile } = req.body || {};

  if (!["windows", "linux", "mac", "apk"].includes(platform)) {
    return res.status(400).json({ error: "platform tidak dikenal" });
  }
  // Validate + block internal/SSRF targets before doing any work.
  let target;
  try {
    target = await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || "URL tidak valid") });
  }
  const packageName = rawPackage && rawPackage.trim() ? rawPackage.trim() : DEFAULT_PACKAGE;
  if (platform === "apk" && !PACKAGE_RE.test(packageName)) {
    return res.status(400).json({ error: "Package name tidak valid, contoh: com.perusahaanmu.namaapp" });
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
    params: { platform, safeUrl: target.href, rawName, iconDataUrl, packageName, singleFile },
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
  const { platform, safeUrl, rawName, iconDataUrl, packageName, singleFile } = job.params;
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
  if (iconPath && platform === "windows") iconPath = await toIco(work, iconPath);

  if (platform === "apk") {
    const apk = await buildApk(work, safeUrl, displayName, iconPath, packageName);
    return { file: apk, name: `${fileBase}.apk` };
  }

  // desktop: nativefier -> folder
  const out = join(work, "out");
  const args = ["--name", displayName, "--platform", NATIVEFIER_PLATFORM[platform]];
  // ponytail: windows gets a converted .ico; linux takes PNG directly.
  // macOS wants .icns and we don't convert that — needs a Mac anyway.
  if (iconPath) args.push("--icon", iconPath);
  args.push(safeUrl, out);
  await run(process.execPath, [await binEntry("nativefier"), ...args], { shell: false });
  const built = join(out, (await readdir(out))[0]); // nativefier makes one subfolder

  if (platform === "windows" && singleFile) {
    const exe = await toPortableExe(work, built, displayName, fileBase, iconPath);
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
async function toPortableExe(work, builtDir, displayName, fileBase, iconPath) {
  // electron-builder wants a project dir with a package.json to read name/version from
  await writeFile(join(work, "package.json"), JSON.stringify({ name: fileBase, version: "1.0.0" }));
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

async function buildApk(work, url, displayName, iconPath, packageName) {
  const proj = join(work, "android");
  await cp(join(__dirname, "android-template"), proj, { recursive: true });
  // inject name + URL into strings.xml placeholders
  const strings = join(proj, "app/src/main/res/values/strings.xml");
  const xml = (await readFile(strings, "utf8"))
    .replace("__TARGET_URL__", xmlEscape(url))
    .replace("__APP_NAME__", xmlEscape(displayName));
  await writeFile(strings, xml);
  // custom package name: patch build.gradle, then move MainActivity.java
  // into the java/ folder that matches the package (Java requires it)
  const gradlePath = join(proj, "app/build.gradle");
  await writeFile(gradlePath, (await readFile(gradlePath, "utf8")).replaceAll("__PACKAGE_NAME__", packageName));
  const javaRoot = join(proj, "app/src/main/java");
  const oldDir = join(javaRoot, "com/html2exe/webapp");
  const mainActivity = (await readFile(join(oldDir, "MainActivity.java"), "utf8")).replace("__PACKAGE_NAME__", packageName);
  await rm(join(javaRoot, "com"), { recursive: true, force: true });
  const newDir = join(javaRoot, ...packageName.split("."));
  await mkdir(newDir, { recursive: true });
  await writeFile(join(newDir, "MainActivity.java"), mainActivity);
  // icon: drop the png into drawable and reference it, else keep Android's default
  const manifest = join(proj, "app/src/main/AndroidManifest.xml");
  let iconAttr = "";
  if (iconPath) {
    const drawable = join(proj, "app/src/main/res/drawable");
    await mkdir(drawable, { recursive: true });
    await cp(iconPath, join(drawable, "app_icon.png"));
    iconAttr = 'android:icon="@drawable/app_icon"';
  }
  await writeFile(manifest, (await readFile(manifest, "utf8")).replace("__ICON_ATTR__", iconAttr));
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

const PORT = process.env.PORT || 4444;
app.listen(PORT, () => {
  console.log(`html2exe → http://localhost:${PORT}`);
  if (!ACCESS_TOKEN) console.warn("[warn] ACCESS_TOKEN kosong — endpoint /api/build terbuka. Set ACCESS_TOKEN untuk membatasi akses.");
});
