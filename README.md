# Web 2 App Converter

Tempel URL → dapat aplikasi desktop (`.exe` / Linux / macOS) atau Android `.apk`.
Bukan bikin browser engine sendiri — cuma bungkus tool yang sudah ada:
[nativefier](https://github.com/nativefier/nativefier) untuk desktop, WebView + Gradle untuk Android.

## Jalankan

```bash
npm install
npm start          # http://localhost:3000
```

Buka browser, tempel URL, pilih platform, klik build.

## Jalankan via Docker

Image sudah membawa semua yang dibutuhkan build Linux: Node, JDK 17, Android SDK,
dan Wine. **Besar (~3–4 GB)** dan build pertama lama karena mengunduh SDK.

```bash
docker compose up -d --build        # http://localhost:4444
```

Atau tanpa compose:

```bash
docker build -t html2app .
docker run -d -p 4444:4444 -e ACCESS_TOKEN=rahasia html2app
```

Kecilkan image dengan mematikan yang tak dipakai (mis. hanya butuh `.exe`):

```bash
docker build --build-arg WITH_ANDROID=0 -t html2app .   # tanpa APK  (~1.5 GB lebih kecil)
docker build --build-arg WITH_WINE=0    -t html2app .   # .exe tanpa ikon/metadata
```

- `ACCESS_TOKEN` diteruskan lewat env — set kalau diekspos publik.
- Volume `electron-cache` menyimpan unduhan Electron/nativefier antar-restart
  (build kedua dst. tak mengunduh ulang ~150 MB).
- **macOS tetap tidak bisa** di Docker — butuh mesin Mac.

## Syarat per platform

| Platform | Butuh apa di server | Status |
|----------|--------------------|--------|
| Windows `.exe` | Node.js; **dari host Linux perlu `wine64`** | ✅ jalan |
| Linux | Node.js saja | ✅ jalan |
| Android `.apk` | Android SDK + `ANDROID_HOME`, dan **JDK** (gradle tidak perlu — pakai wrapper) | ⚙️ perlu setup |
| macOS `.app` | **Mesin Mac** untuk hasil signed | ⚠️ dari OS lain = unsigned, sering ditolak macOS |

APK yang keluar adalah **debug build** (unsigned tapi bisa di-install). Untuk Play Store perlu signing sendiri.

### Build .exe dari server Linux perlu Wine

electron-packager menanamkan ikon dan metadata ke `.exe` memakai `rcedit` — sebuah
program Windows. Di host Linux itu hanya jalan lewat Wine, jadi tanpa itu build
gagal saat tahap *Packaging*:

```
WrapperError: Wrapper command 'wine64' not found on the system.
Wine is required to use the appCopyright, appVersion, buildVersion, icon, and
win32metadata parameters for Windows targets.
```

```bash
sudo apt install -y wine64
wine64 --version
```

Tidak berlaku kalau server-nya Windows — `rcedit` jalan native di sana.

### JDK, bukan JRE

Build APK butuh **JDK** — JRE saja tidak cukup. Gejalanya membingungkan karena
Gradle tetap start dan puluhan task berjalan, lalu gagal di `compileDebugJavaWithJavac`:

```
Toolchain installation '/usr/lib/jvm/java-21-openjdk-amd64'
does not provide the required capabilities: [JAVA_COMPILER]
```

Artinya `java` ada tapi `javac` tidak. Di Debian/Ubuntu:

```bash
sudo apt install -y openjdk-17-jdk-headless
javac -version   # harus keluar versinya, bukan "command not found"
```

Pakai **JDK 17** — AGP 8.2 di template ini resmi menargetkan 17. JDK 21 juga
menyediakan `javac`, tapi belum resmi didukung AGP 8.2.

## Satu file .exe (Windows)

Centang **"Satu file .exe saja"** untuk membungkus seluruh folder Electron
(`.dll`, `.pak`, `.bin`) jadi **satu** `.exe` portable via target `portable`
electron-builder. Saat dijalankan, isinya di-extract ke folder temp lalu app
dibuka — user cuma pegang 1 file.

Perbandingan nyata (github.com): folder ~250 MB → **1 file 60 MB**.

Hasilnya tetap dikirim dalam `.zip` berisi satu `.exe`, bukan `.exe` telanjang —
browser dan antivirus jauh lebih toleran terhadap zip. Zip-nya pakai mode *store*
(tanpa kompresi) karena isi `.exe` portable sudah terkompresi 7z, jadi tak ada
waktu CPU terbuang untuk penghematan ~0%.
Trade-off: build lebih lama, dan startup pertama sedikit lebih lambat karena
proses extract. Hilangkan centang kalau mau folder biasa (zip).

## Keamanan

- **Auth opsional:** set env `ACCESS_TOKEN`. Kalau di-set, `/api/build` wajib mengirim
  header `x-access-token: <token>` atau `Authorization: Bearer <token>`. **Wajib di-set
  kalau server diekspos publik.**
- **Rate limit:** maks `RATE_MAX` build/jam per IP (default 10). Di belakang Cloudflare
  tunnel, IP asli dibaca dari `CF-Connecting-IP`.
- **Anti-SSRF:** URL target divalidasi — hanya `http`/`https`, dan domain yang me-resolve
  ke IP privat/localhost/metadata (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x, dst)
  ditolak.
- **Argument injection:** nama aplikasi & judul situs disanitasi (tak bisa diawali `-`),
  dan URL dipisah dengan `--` sebelum diteruskan ke nativefier.
- **Timeout build:** `BUILD_TIMEOUT_MS` (default 8 menit) — proses yang menggantung dibunuh.
- APK hasil build: cleartext HTTP dimatikan, navigasi WebView dikunci ke domain target.

## Download di APK

WebView tidak menangani unduhan sama sekali secara bawaan — klik file PDF/ZIP
tidak menghasilkan apa pun. Template menangani tiga jalur yang semuanya terlihat
sebagai "tidak terjadi apa-apa":

1. `Content-Disposition: attachment` → `DownloadListener` → `DownloadManager`.
2. File disajikan *inline* (PDF paling sering) → WebView render halaman kosong,
   jadi URL berekstensi file diunduh, bukan dinavigasi.
3. `target="_blank"` / `window.open()` → `onCreateWindow` mengarahkan balik ke
   WebView utama.

Cookie sesi ikut dikirim, jadi unduhan di balik login tetap jalan. File masuk ke
folder **Downloads** publik dengan notifikasi sistem.

**Belum didukung:** URL `blob:` dan `data:` (dibuat di sisi JS) — `DownloadManager`
tidak bisa membacanya. Perlu jembatan JavaScript, tambahkan kalau memang ada situs
yang membutuhkannya.

## Struktur

```
server.js            # Express: POST /api/build {url, platform}
public/index.html    # form UI
android-template/     # proyek WebView minimal, __TARGET_URL__ di-inject saat build
```
