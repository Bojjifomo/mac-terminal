#!/bin/bash
# Double-click di Finder: nyalain Mac Remote di Mac ini, lalu buka link yang muncul di iPhone.
# Biarin jendela Terminal ini kebuka. caffeinate = Mac nggak tidur selama dipakai.
cd "$(dirname "$0")" || exit 1
# Python Apple (/usr/bin/python3) paling aman buat pyobjc; kalau nggak ada, python3 yang ada.
PY=/usr/bin/python3
[ -x "$PY" ] || PY=$(command -v python3)
if [ -z "$PY" ]; then echo "python3 belum ada: jalanin  xcode-select --install  lalu double-click file ini lagi."; read -r -p "Enter buat tutup." _; exit 1; fi
if [ ! -x .venv/bin/python ]; then
  echo "Sekali aja: siapin Python + pyobjc (±1 menit)…"
  "$PY" -m venv .venv && .venv/bin/pip install --quiet --upgrade pip \
    || { rm -rf .venv; read -r -p "Install gagal (lihat error di atas). Enter buat tutup." _; exit 1; }
fi
# requirements.txt changed since the last install (an update added a package): install what is missing
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  echo "Pasang paket Python…"
  .venv/bin/pip install --quiet -r requirements.txt && touch .venv/.installed \
    || { read -r -p "Install gagal (lihat error di atas). Enter buat tutup." _; exit 1; }
fi
echo "Cek izin…"
if ! .venv/bin/python server.py --doctor; then
  echo ""
  echo "Kasih izin dulu: System Settings > Privacy & Security > Screen Recording DAN Accessibility > nyalain Terminal."
  echo "Habis itu tutup Terminal (Cmd+Q), double-click file ini lagi."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  read -r -p "Enter buat tutup." _; exit 1
fi
# -i: no idle sleep, -s: no system sleep on power: the Mac stays reachable from outside while this runs
exec caffeinate -is .venv/bin/python server.py
