# Web 2 App Converter

Tempel URL → dapat aplikasi desktop (`.exe` / Linux / macOS) atau Android `.apk`.
Bukan bikin browser engine sendiri — cuma bungkus tool yang sudah ada:
[nativefier](https://github.com/nativefier/nativefier) untuk desktop, WebView + Gradle untuk Android.

## Preview
<img src="https://raw.githubusercontent.com/TobyG74/Web2App/refs/heads/master/preview.png" width="600">

## Jalankan

```bash
npm install
npm start          # http://localhost:3000
```

Buka browser, tempel URL, pilih platform, lalu klik **Next · Kustomisasi**.
Di langkah kedua, atur logo dan pengaturan opsional, lalu klik **Build & Download**.
Tombol **Kembali** mempertahankan isian di kedua langkah.
Logo yang diunggah dikonversi menjadi PNG persegi dengan latar transparan.
Logo aplikasi dan splash menerima PNG, JPG/JPEG, WebP, SVG, GIF, BMP, TIFF,
AVIF, dan ICO, maksimal 5 MB dan 16 megapiksel. GIF/format animasi memakai
frame pertama. Konversi dilakukan di server menggunakan Sharp, tanpa aplikasi
konversi tambahan. Format di luar daftar ini perlu dikonversi terlebih dahulu.
Tanpa unggahan, server membaca favicon dari HTML situs (termasuk URL relatif
dan `apple-touch-icon`), lalu mencoba `/favicon.ico`. Pratinjau dan build membaca
langsung dari situs, dengan permintaan tanpa cache; layanan favicon pihak ketiga
tidak dipakai agar ikon versi lama tidak terbawa. Mengosongkan input logo atau
menekan **Pakai icon situs (auto)** membuang unggahan sebelumnya, termasuk
konversi yang masih berjalan. Build mengambil ulang favicon sesuai URL terbaru.
Favicon ICO juga dikonversi ke PNG untuk Android; jika semua sumber gagal,
aplikasi tetap mendapat ikon bawaan. Naikkan version code untuk pembaruan APK;
launcher Android tertentu dapat menyimpan ikon aplikasi yang sudah terpasang.
Ikon Windows dibuat menjadi ICO di Node.js, tanpa ImageMagick atau GraphicsMagick.

## Versi dan splash screen

Buka **Versi & identitas aplikasi** untuk mengatur:

- **Versi aplikasi:** semua platform. Desktop memakai format `1.2.3`;
  Android juga menerima label seperti `1.2.3-beta`.
- **Package name:** Android, contoh `com.perusahaanmu.namaapp`.
- **Version code:** Android, bilangan bulat 1–2100000000. Naikkan untuk setiap pembaruan.

Kolom kosong tetap memakai nilai bawaan: versi Android `1.0`, desktop `1.0.0`,
package `com.html2exe.webapp`, dan version code `1`.

Di **Splash screen (opsional)**, centang **Aktifkan splash screen**. Tombol animasi
menawarkan fade, zoom, slide up, bounce, rotate, pulse, flip, atau tanpa animasi.
Loading bisa memakai spinner, dots, bars, pulse ring, atau dinonaktifkan.
Splash memakai bingkai logo dengan sudut bulat, judul, dan indikator loading.
Judul, subjudul, warna latar,
warna teks, dan durasi 500–5000 ms bisa diganti. Logo terpisah menerima format
gambar yang sama, maksimal 5 MB; tanpa logo, splash memakai icon aplikasi. Tombol pratinjau dapat
memutar ulang animasi. Animasi menghormati pengaturan reduced motion browser
dan pengaturan animasi sistem Android.

Splash Android tampil ketika aplikasi dibuka, sementara website dimuat di belakangnya.
Android 12 ke atas tetap memiliki splash bawaan sistem sebelum splash kustom.
Splash kustom ditutup sesuai durasi yang dipilih, tanpa menunggu callback splash
sistem atau selesainya loading website.
Splash desktop muncul setelah DOM halaman awal siap, sekali per sesi halaman;
animasi dan durasinya dimulai saat jendela terlihat. Splash desktop memakai Shadow
DOM agar CSS website tidak mengubah logo, teks, atau indikator loading.
Splash desktop tidak mencakup waktu ekstraksi EXE portable atau waktu tunggu jaringan sebelum DOM siap.
Splash tidak aktif secara bawaan dan tidak mengubah website sumber.

API `/api/build` menerima tambahan `versionName`, `versionCode`, `packageName`,
dan `splash`. Contoh:

```json
{
  "url": "https://example.com",
  "platform": "apk",
  "name": "Aplikasi Saya",
  "packageName": "com.perusahaanmu.namaapp",
  "versionName": "2.1.0",
  "versionCode": 21,
  "splash": {
    "enabled": true,
    "animation": "zoom",
    "loader": "dots",
    "duration": 2000,
    "background": "#ffe253",
    "foreground": "#202020",
    "title": "Aplikasi Saya",
    "subtitle": "Selamat datang"
  }
}
```

Jalankan `npm test` untuk memeriksa validasi dan pembuatan metadata/resource Android.

Setelah memperbarui kode dan `package-lock.json`, jalankan `npm ci --omit=dev`
untuk memasang dependensi konversi gambar di server. Konversi berada di
`build-options.js`; tidak ada ketergantungan ke berkas `images.js` terpisah.
Pastikan `server.js`, `build-options.js`, `public/`, dan template Android ikut
disalin ke server. Restart proses PM2 dengan
`pm2 restart html2app --update-env`, lalu build dan instal APK baru. Perubahan
template tidak memperbarui APK yang sudah terpasang.

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
