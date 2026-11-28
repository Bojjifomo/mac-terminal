# Mac Terminal (Mac Remote)

Kendaliin Mac mini dan MacBook Pro dari iPhone. Layar Mac di atas, keyboard MacBook + trackpad di bawah, kayak MacBook mini.

- **Layar**: gambar layar Mac live. Tap di layar = klik di situ, geser langsung = drag. **Tahan sebentar lalu geser = ngepas pakai kaca pembesar** (muncul di atas jari, jadi jari nggak nutupin target), lepas = klik.
- **🔍 Kaca pembesar (klik akurat)**: lingkaran pembesar di dekat pointer, tanda **+** merah = titik persis yang bakal diklik. Isinya potongan layar Mac dalam **resolusi asli** (tulisan "tajam"), bukan gambar kecil yang di-zoom. Mode di tombol 🔍 atau ⚙: **Auto** (muncul sendiri pas jari di trackpad pelan / diam: lagi ngepas, hilang pas geser cepat), **Selalu nyala**, **Mati**. Perbesar 2× / 3× / 4× / 6×. Selama kaca nyala, pointer gerak lebih pelan biar gampang ngepas (bisa dimatiin di ⚙).
- **Keyboard**: layout MacBook lengkap (esc + F1–F12 opsional, angka, huruf, ⇧ ⌃ ⌥ ⌘ fn, panah). Tahan ⌫ / panah = berulang.
- **Modifier**: tap ⌘ sekali = buat tombol berikutnya (⌘C, ⌘V). Tap dua kali atau tahan = dikunci dan beneran ditahan di Mac (⌘+Tab: kunci ⌘, tap Tab berkali-kali, tap ⌘ lagi). fn + panah = Home / End / PgUp / PgDn.
- **Trackpad**: 1 jari geser (pakai akselerasi), tap = klik, tap dua kali = double click, 2 jari tap = klik kanan, tahan atau tap-lalu-geser = drag, 3 jari kiri/kanan = ganti desktop, 3 jari atas = Mission Control.
- **Aa**: ketik pakai keyboard iPhone (lebih cepat buat teks panjang, dikte suara juga bisa).
- **Keyboard Bluetooth / Magic Keyboard** yang nyambung ke iPhone langsung ngetik ke Mac, shortcut ⌘ ⌥ ⌃ ikut.
- **Baris atas ala Touch Bar**: ikut app yang lagi kebuka di Mac. **Terminal / iTerm / VS Code / Cursor**: esc, tab, panah, ⌃C, ⌃D, ⌃R, ⌘K, ⌃A, ⌃E (tahan = berulang). Browser: ◀︎ ▶︎ ⟳ tab baru / tutup / zoom. Music, Spotify, YouTube: ⏮ ⏯ ⏭ (tombol media Mac). Keynote / PowerPoint: slide maju / mundur. Finder: folder baru. Lainnya: Mission Control, desktop, Spotlight, volume, 🔒 kunci Mac.
- **📋 Clipboard dua arah**: copy di Mac → muncul bar "Salin ke HP". Tombol 📋 → tempel teks dari HP → masuk clipboard Mac (atau langsung ⌘V).
- **📎 Kirim foto / file** ke folder Downloads Mac (nama yang udah ada jadi "(2)", nggak pernah ditimpa).
- **Trackpad**: scroll 2 jari pakai **momentum** (lepas jari, halamannya jalan terus pelan-pelan berhenti), **cubit = zoom** (⌘+ / ⌘−, buat browser, Preview, Maps), **4 jari** kiri/kanan = ganti app, atas = tampilin desktop.
- **Cubit di layar** = zoom gambar layar di HP (geser pakai 2 jari, pointer selalu diikutin). Tombol `2.0× ⟲` di bawah layar buat balik.
- **Bunyi klik** pas ngetik (bisa dimatiin di ⚙).

## Akses dari luar rumah

Ini fokusnya, dan yang bikin beda dari DuoBook:

- **Kualitas otomatis** (default, ⚙ > Kualitas: Auto): Mac ngukur berapa lama HP nampilin tiap gambar. Sinyal jelek → gambar dikecilin (sampai 40%) biar tetap lancar. Sinyal bagus lagi → ditajamin pelan-pelan.
- **Info koneksi** selalu kelihatan di bawah layar: fps + ping (ms). Detail (ukuran gambar, KB, delay) di ⚙ > Di luar rumah.
- **Kunci Mac pas HP putus** (⚙ > Di luar rumah): HP terakhir putus → Mac langsung terkunci (⌃⌘Q). Orang di rumah nggak bisa lihat atau pakai sesi lo.
- **Mac nggak tidur** selama `Mac Remote.command` jalan (`caffeinate -is`), jadi tetap bisa dijangkau.
- **Nyambung lagi sendiri** kalau sinyal putus (masuk lift, pindah Wi-Fi ke 4G).
- **Tailscale**: tanpa buka port router. Koneksi terenkripsi, cuma device lo yang bisa nyambung.
- **Clipboard di HTTP biasa**: lewat Tailscale halamannya `http://`, jadi iPhone nggak ngizinin baca clipboard otomatis. Makanya tempel dari HP lewat kotak 📋 (tahan → Paste).
- **Dua Mac**: tombol nama Mac di pojok kanan atas = pindah Mac (kalau ada 2, sekali tap langsung pindah). ⚙ = daftar Mac, kualitas, fps, kecepatan trackpad, arah scroll.
- **⤢**: layar penuh (keyboard disembunyiin), ⌨︎ buat balik.

## Kenapa sekarang lebih cepat (v1.1+)

Belajar dari [Sill](https://github.com/Saffsanity/sill) (app native yang ngelakuin hal sama):

| | v1.0 | v1.1 |
| --- | --- | --- |
| Koneksi | 1 request HTTP per gambar (nunggu bolak-balik tiap frame) | **1 WebSocket** yang terus kebuka: Mac langsung ngirim gambar baru |
| Ambil layar | Screenshot per frame | **ScreenCaptureKit stream**: macOS cuma ngasih frame kalau layar berubah. Layar diam = 0 data |
| Kalau jaringan lambat | Gambar antre | Maks 2 gambar di jalan, yang lama dibuang: selalu yang terbaru |
| Pointer | Ikut gambar (telat) | Digambar di HP: gerak langsung pas jari gerak |
| Ukuran gambar default | ~2000 px | 1280 px (⚙ > Kualitas: Hemat 960, Tajam 1920) |
| Input | 1 request per kumpulan | Lewat socket yang sama, digabung per frame layar (60/detik) |

Tes pakai jaringan lambat buatan (40 ms tiap arah, kira-kira Tailscale): 10.7 → 21 fps waktu layar terus berubah. Di Mac beneran stream ScreenCaptureKit nambah lagi (nggak screenshot tiap frame).

Kalau jaringan nolak WebSocket, app otomatis balik ke cara lama.

Masih belum semulus Sill: Sill ngirim video HEVC (chip video Mac) ke app native. Kalau mau yang paling mulus, pakai Sill.

## Pasang di tiap Mac (Mac mini dan MacBook Pro)

Butuh macOS 14 ke atas (biar layar diambil lewat ScreenCaptureKit). Di macOS lebih lama tetap jalan, tapi pakai cara cadangan.

1. Ambil kodenya:

```bash
cd ~/Projects/src && git clone https://github.com/Bojjifomo/mac-terminal.git
```

Kalau udah pernah di-clone, update aja:

```bash
cd ~/Projects/src/mac-terminal && git pull
```

2. Double-click **`Mac Remote.command`** (di folder `~/Projects/src/mac-terminal`) di Finder.
   - Pertama kali dia nyiapin Python + pyobjc sendiri (±1 menit).
   - macOS bakal minta izin **Screen Recording** dan **Accessibility** buat Terminal. Nyalain dua-duanya di System Settings > Privacy & Security, tutup Terminal (Cmd+Q), double-click lagi.
3. Terminal nge-print link kayak gini:

```
Mac Remote · Mac mini · port 8787
Buka di HP (salah satu, yang nyambung):
  http://mac-mini:8787/?token=…
  http://100.x.y.z:8787/?token=…
```

Biarin jendela Terminal itu kebuka.

Lakuin hal yang sama di MacBook Pro.

**Update dari versi sebelumnya:** stop yang lagi jalan (Ctrl+C di jendela Terminal-nya), `git pull`, double-click `Mac Remote.command` lagi. Dia pasang paket baru sendiri. Di iPhone tinggal tutup app-nya (swipe up) dan buka lagi.

## Di iPhone

1. Nyalain **Tailscale** di iPhone (Mac-nya juga harus nyala Tailscale). Di Wi-Fi rumah yang sama, link `http://192.168…` juga bisa.
2. Buka link dari **Mac mini** di Safari. Layar Mac langsung muncul.
3. Share > **Add to Home Screen** biar kebuka full screen kayak app.
4. Tambah MacBook Pro: ⚙ > tempel link dari MacBook Pro > **Tambah**. Sekarang tombol nama Mac di pojok kanan atas tinggal di-tap buat pindah.

## Biar nyala sendiri

Supaya nggak perlu double-click tiap nyalain Mac: System Settings > General > Login Items > **+** > pilih `Mac Remote.command`.

## Keamanan

- Tiap request butuh **token** dari link. Siapa pun yang punya link-nya bisa ngontrol Mac itu, jadi jangan dibagi.
- Link bocor? Bikin token baru (link lama langsung mati), lalu tambah lagi Mac-nya di iPhone:

```bash
cd ~/Projects/src/mac-terminal && .venv/bin/python server.py --new-token
```

- Pakai lewat Tailscale atau Wi-Fi rumah aja. Jangan buka port 8787 ke internet.

## Kalau ada masalah

Cek izin dan cara ambil layar:

```bash
cd ~/Projects/src/mac-terminal && .venv/bin/python server.py --doctor
```

| Gejala | Biasanya |
| --- | --- |
| Layar cuma wallpaper / hitam | Izin Screen Recording belum ada buat Terminal |
| Layar muncul, tapi klik / ketik nggak ngaruh | Izin Accessibility belum ada buat Terminal |
| "Nggak nyambung ke …" | Server di Mac mati, atau Tailscale di iPhone / Mac mati |
| Patah-patah | ⚙ > Kualitas: **Hemat**. Pojok kanan atas nunjukin fps (`● live` = layar Mac lagi diam, nggak ada yang dikirim) |
| Tulisan "mode lama" | Jaringan nolak WebSocket: masih jalan, tapi lebih lambat |
| Scroll kebalik | ⚙ > Balik arah scroll |

## Coba tanpa Mac

```bash
python3 server.py --demo
```

Pura-pura jadi Mac (butuh `pip install pillow`): ada jendela Notes yang nampilin apa yang lo ketik.

## Test

```bash
python3 -m unittest discover -s tests
```
