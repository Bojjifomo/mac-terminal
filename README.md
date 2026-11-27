# Mac Terminal (Mac Remote)

Kendaliin Mac mini dan MacBook Pro dari iPhone. Layar Mac di atas, keyboard MacBook + trackpad di bawah, kayak MacBook mini.

- **Layar**: gambar layar Mac live (JPEG, sampai 60 fps tergantung jaringan). Tap di layar = klik di situ, geser = drag, tahan = klik kanan.
- **Keyboard**: layout MacBook lengkap (esc + F1–F12 opsional, angka, huruf, ⇧ ⌃ ⌥ ⌘ fn, panah). Tahan ⌫ / panah = berulang.
- **Modifier**: tap ⌘ sekali = buat tombol berikutnya (⌘C, ⌘V). Tap dua kali atau tahan = dikunci dan beneran ditahan di Mac (⌘+Tab: kunci ⌘, tap Tab berkali-kali, tap ⌘ lagi). fn + panah = Home / End / PgUp / PgDn.
- **Trackpad**: 1 jari geser (pakai akselerasi), tap = klik, tap dua kali = double click, 2 jari geser = scroll, 2 jari tap = klik kanan, tahan atau tap-lalu-geser = drag, 3 jari kiri/kanan = ganti desktop, 3 jari atas = Mission Control.
- **Aa**: ketik pakai keyboard iPhone (lebih cepat buat teks panjang, dikte suara juga bisa).
- **Baris tombol**: Mission Control, desktop kiri/kanan, Spotlight, volume, mute.
- **Dua Mac**: tombol nama Mac di pojok kanan atas = pindah Mac (kalau ada 2, sekali tap langsung pindah). ⚙ = daftar Mac, kualitas, fps, kecepatan trackpad, arah scroll.
- **⤢**: layar penuh (keyboard disembunyiin), ⌨︎ buat balik.

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
| Patah-patah | ⚙ > Kualitas: **Hemat**, atau Maks fps diturunin |
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
