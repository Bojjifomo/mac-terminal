"use strict";
// Mac Remote: the screen of a Mac on top, a MacBook keyboard + trackpad below.
// Talks to server.py on each Mac: GET /api/frame (JPEG), POST /api/input (events), GET /api/info.

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("mr." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mr." + k, JSON.stringify(v)); } catch {} },
};
const S = {
  devices: store.get("devices", []),
  cur: store.get("cur", 0),
  quality: store.get("quality", "auto"),         // auto = follows the signal (away from home)
  sound: store.get("sound", true),
  lockLeave: store.get("lockLeave", false),
  fps: store.get("fps", 24),
  frow: store.get("frow", false),
  speed: store.get("speed", 1.6),
  scroll: store.get("scroll", 1.4),
  invert: store.get("invert", false),
  loupe: store.get("loupe", "auto"),            // magnifier: auto | on | off
  zoom: store.get("zoom", 3),
  precise: store.get("precise", true),
  display: 0,
  info: null,
};
// picture width in pixels (capped by the screen's own size) and JPEG quality
const QUALITY = { auto: { w: 1600, q: 0.6 }, low: { w: 960, q: 0.45 }, mid: { w: 1280, q: 0.55 }, high: { w: 1920, q: 0.65 } };
const dev = () => S.devices[S.cur] || null;
const api = (path, extra = "") => `${dev().url}${path}?token=${encodeURIComponent(dev().token)}${extra}`;

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- devices
function adoptLinkFromUrl() {
  const u = new URL(location.href);
  const token = u.searchParams.get("token");
  if (!token) return;
  addDevice(location.origin, token, null, true);
  u.searchParams.delete("token");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}
function addDevice(url, token, name, select) {
  url = url.replace(/\/+$/, "");
  let i = S.devices.findIndex(d => d.url === url);
  if (i < 0) { S.devices.push({ url, token, name: name || new URL(url).hostname }); i = S.devices.length - 1; }
  else { S.devices[i].token = token; if (name) S.devices[i].name = name; }
  store.set("devices", S.devices);
  if (select) switchDevice(i, true);
  return i;
}
function switchDevice(i, quiet) {
  if (!S.devices[i]) return;
  releaseHeld();
  S.cur = i;
  store.set("cur", i);
  S.display = 0;
  S.info = null;
  $("#devName").textContent = dev().name;
  $("#label").textContent = dev().name;
  connect();
  if (!quiet) toast("→ " + dev().name);
  renderSheet();
}
// The screen box is sized to exactly the Mac's picture (no black bars inside it). With bars, the pointer, taps and
// the magnifier were placed against the whole box, not the picture: off by the bar's width in landscape.
function fitScreen() {
  const el = $("#screen"), bez = $("#bezel");
  const d = (S.info?.displays || [])[S.display];
  const a = d ? d.w / d.h : (live.sw && live.sh ? live.sw / live.sh : 16 / 10);
  const bs = getComputedStyle(bez);
  const W = bez.clientWidth - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight);
  let H;
  if (document.body.classList.contains("full")) H = bez.clientHeight - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom);
  else {
    el.style.height = "";                                          // read the CSS limit without our own value
    H = parseFloat(getComputedStyle(el).maxHeight);
  }
  if (!isFinite(H) || H <= 0) H = Infinity;
  const w = Math.max(50, Math.min(W, H * a));
  el.style.width = w + "px";
  el.style.height = w / a + "px";
}
function applyInfo(j) {
  S.info = j;
  dev().name = j.name;
  store.set("devices", S.devices);
  $("#devName").textContent = j.name;
  $("#label").textContent = j.name;
  $("#dispBtn").hidden = (j.displays || []).length < 2;
  $("#dispBtn").textContent = "▣ " + (S.display + 1);
  const d = (j.displays || [])[S.display];
  if (d) { $("#screen").style.aspectRatio = `${d.w} / ${d.h}`; live.sw = d.w; live.sh = d.h; }
  fitScreen();
}
async function loadInfo() {
  const r = await fetch(api("/api/info"));
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || r.status);
  applyInfo(j);
}

// ---------------------------------------------------------------- live connection
// One WebSocket that stays open: the Mac pushes each new picture as soon as it has one, only when the screen
// changed, and at most two ahead of what this phone has shown (older ones are dropped, never queued). Taps and
// keys go back on the same socket. If a network refuses WebSockets, it falls back to asking picture by picture.
const live = { seq: 0, moveSeq: 0, ws: null, gen: 0, mode: "ws", fails: 0, frames: 0, t0: performance.now(), sw: 0, sh: 0,
  cursor: { x: 0.5, y: 0.5 }, localAt: 0, drawn: 0, got: 0 };
const canvas = $("#frame");
const ctx2d = canvas.getContext("2d");
function setStatus(msg) {
  const s = $("#status");
  if (msg) { s.textContent = msg; s.classList.remove("hide"); } else s.classList.add("hide");
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function frameSpec() {
  const qq = QUALITY[S.quality] || QUALITY.mid;
  const w = Math.round(Math.min(qq.w, $("#screen").clientWidth * (window.devicePixelRatio || 1)));
  return { w: Math.max(320, w), q: qq.q };
}
function sendCfg() {
  const ws = live.ws;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "cfg", ...frameSpec(), quality: S.quality, fps: S.fps, d: S.display,
    lockOnLeave: S.lockLeave }));
}
// round trip to the Mac every 2 s: shown under the screen, so a bad signal is visible, not a mystery
setInterval(() => {
  const ws = live.ws;
  if (ws && ws.readyState === 1 && !document.hidden) ws.send(JSON.stringify({ t: "ping", ts: performance.now() }));
}, 2000);
function wsUrl() {
  const u = new URL(dev().url);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/api/ws?token=${encodeURIComponent(dev().token)}`;
}
function disconnect() {
  live.gen++;
  if (live.ws) { const w = live.ws; live.ws = null; w.onclose = null; try { w.close(); } catch {} }
}
function connect() {
  disconnect();
  const gen = live.gen;
  if (!dev() || document.hidden) return;
  if (live.mode === "poll") { pollLoop(gen); return; }
  setStatus(`Nyambung ke ${dev().name}…`);
  let opened = false;
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch { live.mode = "poll"; return connect(); }
  ws.binaryType = "arraybuffer";
  live.ws = ws;
  ws.onopen = () => { opened = true; live.fails = 0; sendCfg(); flushInput(); };
  ws.onmessage = e => {
    if (gen !== live.gen) return;
    if (typeof e.data === "string") onText(JSON.parse(e.data));
    else onFrame(e.data, ws);
  };
  ws.onclose = () => {
    if (gen !== live.gen) return;
    live.ws = null;
    if (!opened && ++live.fails >= 2) {
      live.mode = "poll";
      toast("WebSocket nggak bisa di jaringan ini: pakai mode lama (lebih lambat)", 4000);
      return connect();
    }
    setStatus(`Putus dari ${dev().name}, nyambung lagi…`);
    setTimeout(() => { if (gen === live.gen) connect(); }, opened ? 500 : 1500);
  };
}
function onText(m) {
  if (m.t === "pong") { live.rtt = Math.round(performance.now() - m.ts); return; }
  if (m.t === "clip") return onMacClip(m.s);
  if (m.t === "app") return renderTouchBar(m);
  if (m.t === "info") { applyInfo({ ok: true, ...m }); loupe.serverZoom = !!m.zoom; loupe.sentOn = false; }
  else if (m.t === "zoomoff") loupe.serverZoom = false;
  else if (m.t === "cursor") setCursor(m.c);
  else if (m.t === "error") setStatus(`${dev().name}: ${m.error}`);
}
async function drawJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
  ctx2d.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
}
async function onFrame(buf, ws) {
  const hl = new DataView(buf).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  if (head.t === "zoom") return onZoom(head, new Uint8Array(buf, 4 + hl), ws);
  const n = ++live.got;
  try {
    const blob = new Blob([new Uint8Array(buf, 4 + hl)], { type: "image/jpeg" });
    if (n > live.drawn) {                             // a newer picture may have decoded first: never go back
      await drawJpeg(blob);
      live.drawn = Math.max(live.drawn, n);
    }
  } catch {}
  if (ws.readyState === 1) ws.send('{"t":"ack"}');   // ready for the next one
  if (head.sw) { live.sw = head.sw; live.sh = head.sh; }
  live.net = { kb: head.kb, w: head.w, lag: head.lag, auto: head.auto };
  setCursor(head.c);
  countFrame();
  setStatus("");
}
function countFrame() { live.frames++; }
setInterval(() => {
  const now = performance.now();
  const fps = Math.round(live.frames * 1000 / (now - live.t0));
  live.frames = 0;
  live.t0 = now;
  const on = live.ws && live.ws.readyState === 1;
  const rtt = on && live.rtt != null ? ` · ${live.rtt} ms` : "";
  $("#fps").textContent = !dev() ? "" : (fps ? `${fps} fps` : on ? "● live" : "") + rtt;
  const n = live.net;
  if (n) $("#netInfo").textContent = `Koneksi: ${live.rtt ?? "–"} ms bolak-balik · gambar ${n.w}px, ${n.kb} KB · tampil di HP ${n.lag} ms`
    + (n.auto ? " · kualitas auto" : "") + (live.mode === "poll" ? " · mode lama (tanpa WebSocket)" : "");
}, 1000);

// the pointer is drawn here, so it moves the moment the finger does; the Mac's position corrects it
function placeCursor() {
  if (view.s > 1.001) {                                       // zoomed in: follow the pointer when it nears an edge
    const el = $("#screen"), w = el.clientWidth, h = el.clientHeight, m = 28;
    const px = live.cursor.x * w * view.s + view.x, py = live.cursor.y * h * view.s + view.y;
    if (px < m) view.x += m - px; else if (px > w - m) view.x -= px - (w - m);
    if (py < m) view.y += m - py; else if (py > h - m) view.y -= py - (h - m);
    applyView();
  }
  const c = $("#cursor");
  c.style.left = live.cursor.x * 100 + "%";
  c.style.top = live.cursor.y * 100 + "%";
}
// The Mac marks each position with the last batch of input it had handled ([x, y, seq]). A position from before our
// latest move is old news (on a slow link it arrives after the finger moved on): taking it made the pointer jump
// back. So it is taken only once the Mac has caught up; then it is the truth (and shows a mouse moved at the Mac).
function setCursor(c) {
  if (!c || !isFinite(c[0])) return;
  if (c.length > 2 && isFinite(c[2])) { if (c[2] < live.moveSeq) return; }
  else if (performance.now() - live.localAt < 350) return;          // older server: no marks, wait a moment
  if (Math.abs(live.cursor.x - c[0]) < 1e-4 && Math.abs(live.cursor.y - c[1]) < 1e-4) return;
  live.cursor = { x: c[0], y: c[1] };
  placeCursor();
paintLoupeBtn();
renderTouchBar();
fitScreen();
requestAnimationFrame(loupeTick);
}
function predict(ev) {
  if (ev.t === "move" && live.sw) {
    live.cursor.x = Math.min(1, Math.max(0, live.cursor.x + ev.dx / live.sw));
    live.cursor.y = Math.min(1, Math.max(0, live.cursor.y + ev.dy / live.sh));
  } else if (ev.t === "moveTo") live.cursor = { x: ev.x, y: ev.y };
  else return;
  live.localAt = performance.now();
  placeCursor();
}

// the old way (a network that blocks WebSockets): ask for each picture
async function pollLoop(gen) {
  let since = "";
  try { await loadInfo(); } catch (e) { setStatus(`Nggak nyambung ke ${dev().name}: ${e.message}`); }
  while (gen === live.gen) {
    if (document.hidden) { await sleep(400); continue; }
    const t0 = performance.now();
    const { w, q } = frameSpec();
    try {
      const r = await fetch(api("/api/frame", `&w=${w}&q=${q}&d=${S.display}&since=${since}`), { cache: "no-store" });
      if (r.status === 200) {
        await drawJpeg(await r.blob());
        since = r.headers.get("X-Frame") || "";
        countFrame();
      } else if (r.status !== 204) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "HTTP " + r.status);
      }
      setCursor((r.headers.get("X-Cursor") || "").split(",").map(Number));
      setStatus("");
    } catch (e) {
      setStatus(`Nggak nyambung ke ${dev().name}: ${e.message}`);
      await sleep(1200);
    }
    const wait = 1000 / S.fps - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
  }
}

// ---------------------------------------------------------------- input
// Moves and scrolls are merged per screen refresh (60 a second at most); everything else goes at once, in order.
const queue = [];
let rafPending = false, httpSending = false;
function send(ev) {
  if (!dev()) return;
  predict(ev);
  const last = queue[queue.length - 1];
  if (last && (ev.t === "move" || ev.t === "scroll") && last.t === ev.t) { last.dx += ev.dx; last.dy += ev.dy; }
  else queue.push(ev);
  if (ev.t === "move" || ev.t === "scroll") {
    if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; flushInput(); }); }
  } else flushInput();
}
function flushInput() {
  if (!queue.length) return;
  const ws = live.ws;
  if (ws && ws.readyState === 1) {
    const ev = queue.splice(0);
    const seq = ++live.seq;
    if (ev.some(e => e.t === "move" || e.t === "moveTo")) live.moveSeq = seq;
    ws.send(JSON.stringify({ t: "input", ev, seq }));
    return;
  }
  if (live.mode === "poll") httpFlush();
}
async function httpFlush() {
  if (httpSending || !queue.length) return;
  httpSending = true;
  const batch = queue.splice(0);
  try {
    const r = await fetch(api("/api/input"), { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(batch) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast("✗ " + (j.error || r.status)); }
  } catch (e) { toast("✗ input: " + e.message); }
  httpSending = false;
  if (queue.length) httpFlush();
}

// ---------------------------------------------------------------- keyboard
// [label, key, width, shifted label]; key = name the server knows (keys.py) or a modifier / special
const ROWS = [
  { cls: "f", keys: [["esc", "escape", 1.4], ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`, 1])] },
  { keys: [["`", "`", 1, "~"], ["1", "1", 1, "!"], ["2", "2", 1, "@"], ["3", "3", 1, "#"], ["4", "4", 1, "$"], ["5", "5", 1, "%"],
    ["6", "6", 1, "^"], ["7", "7", 1, "&"], ["8", "8", 1, "*"], ["9", "9", 1, "("], ["0", "0", 1, ")"], ["-", "-", 1, "_"],
    ["=", "=", 1, "+"], ["⌫", "delete", 1.5]] },
  { keys: [["⇥", "tab", 1.5], ..."qwertyuiop".split("").map(c => [c, c, 1]), ["[", "[", 1, "{"], ["]", "]", 1, "}"], ["\\", "\\", 1, "|"]] },
  { keys: [["⇪", "caps", 1.8], ..."asdfghjkl".split("").map(c => [c, c, 1]), [";", ";", 1, ":"], ["'", "'", 1, '"'], ["↩", "return", 1.8]] },
  { keys: [["⇧", "shift", 2.35], ..."zxcvbnm".split("").map(c => [c, c, 1]), [",", ",", 1, "<"], [".", ".", 1, ">"], ["/", "/", 1, "?"], ["⇧", "shift", 2.35]] },
  { keys: [["fn", "fn", 1], ["⌃", "control", 1], ["⌥", "option", 1], ["⌘", "command", 1.3], ["", "space", 5.2], ["⌘", "command", 1.3], ["⌥", "option", 1], ["ARROWS"]] },
];
const MODS = ["shift", "control", "option", "command", "fn"];
// symbol on top, name below (short names: a phone keyboard is narrow)
const MOD_LABEL = { shift: ["⇧", "shift"], control: ["⌃", "ctrl"], option: ["⌥", "opt"], command: ["⌘", "cmd"], fn: ["", "fn"] };
const REPEAT = new Set(["delete", "left", "right", "up", "down", "space", "return"]);
const FN_MAP = { left: "home", right: "end", up: "pageup", down: "pagedown", delete: "forwarddelete" };
const mod = Object.fromEntries(MODS.map(m => [m, "off"]));   // off | once | lock
let caps = false;
const modTap = {};

function keyEl(label, key, w, shifted, side) {
  const b = document.createElement("div");
  b.className = "k";
  b.dataset.key = key;
  b.style.flexGrow = w;
  if (MODS.includes(key)) {
    b.classList.add("mod", side || "l");
    const [sym, name] = MOD_LABEL[key];
    b.innerHTML = key === "shift" ? `<span>${sym} ${name}</span>` : `<span class="sym">${sym}</span><span class="nm">${name}</span>`;
  } else if (["delete", "tab", "caps", "return", "escape"].includes(key)) {
    b.classList.add("wide");
    b.textContent = { delete: "⌫ delete", tab: "⇥ tab", caps: "⇪ caps", return: "↩ return", escape: "esc" }[key];
  } else if (shifted) {
    b.innerHTML = `<span class="sub">${shifted.replace("<", "&lt;").replace(">", "&gt;")}</span><span>${label}</span>`;
  } else b.textContent = label;
  if (key === "caps") b.dataset.caps = "1";
  return b;
}
function buildKeyboard() {
  const kb = $("#kb");
  kb.innerHTML = "";
  for (const row of ROWS) {
    if (row.cls === "f" && !S.frow) continue;
    const r = document.createElement("div");
    r.className = "row " + (row.cls || "");
    let seenSpace = false;
    for (const [label, key, w, shifted] of row.keys) {
      if (label === "ARROWS") {
        const a = document.createElement("div");
        a.className = "arrows";
        const ud = document.createElement("div");
        ud.className = "ud";
        ud.append(keyEl("▲", "up", 1), keyEl("▼", "down", 1));
        a.append(keyEl("◀", "left", 1), ud, keyEl("▶", "right", 1));
        r.append(a);
        continue;
      }
      if (key === "space") seenSpace = true;
      r.append(keyEl(label, key, w, shifted, seenSpace ? "r" : "l"));
    }
    kb.append(r);
  }
  paintMods();
}
function paintMods() {
  document.querySelectorAll("#kb .k").forEach(k => {
    const m = k.dataset.key;
    k.classList.toggle("once", MODS.includes(m) && mod[m] === "once");
    k.classList.toggle("lock", (MODS.includes(m) && mod[m] === "lock") || (m === "caps" && caps));
    if (m.length === 1 && /[a-z]/.test(m)) k.textContent = (mod.shift !== "off") !== caps ? m.toUpperCase() : m;
  });
}
function activeMods() { return MODS.filter(m => mod[m] !== "off" && m !== "fn"); }
function pressKey(key) {
  let k = key;
  if (mod.fn !== "off" && FN_MAP[k]) k = FN_MAP[k];
  const mods = activeMods();
  if (caps && /^[a-z]$/.test(k) && !mods.includes("shift")) mods.push("shift");
  send({ t: "key", k, mods });
}
function afterKey() {
  let changed = false;
  for (const m of MODS) if (mod[m] === "once") { mod[m] = "off"; changed = true; }
  if (changed) paintMods();
}
function setMod(m, state) {
  const was = mod[m];
  mod[m] = state;
  // a locked modifier is really held down on the Mac (Cmd+Tab, Cmd+click); once / off only travel with keys
  if (state === "lock" && was !== "lock") send({ t: "mod", k: m, down: true });
  if (state !== "lock" && was === "lock") send({ t: "mod", k: m, down: false });
  paintMods();
}
function tapMod(m) {
  const now = performance.now();
  const dbl = now - (modTap[m] || 0) < 350;
  modTap[m] = now;
  if (mod[m] === "lock") setMod(m, "off");
  else if (mod[m] === "once") setMod(m, dbl ? "lock" : "off");
  else setMod(m, "once");
}
function releaseHeld() {
  for (const m of MODS) if (mod[m] === "lock") setMod(m, "off");
  if (pad.dragging) { send({ t: "up", b: "left" }); pad.dragging = false; $("#pad").classList.remove("drag"); }
  for (const m of MODS) mod[m] = "off";
  paintMods();
}

const pressing = new Map();       // pointerId -> {el, key, timer, repeated, longTimer}
function kbDown(e) {
  const el = e.target.closest(".k");
  if (!el) return;
  e.preventDefault();
  const key = el.dataset.key;
  el.classList.add("down");
  click(key === "space" ? "space" : "key");
  const p = { el, key, repeated: false };
  if (MODS.includes(key)) {
    p.longTimer = setTimeout(() => { p.long = true; setMod(key, "lock"); }, 450);
  } else if (REPEAT.has(key)) {
    p.timer = setTimeout(function rep() { p.repeated = true; pressKey(key); p.timer = setTimeout(rep, 60); }, 420);
  }
  pressing.set(e.pointerId, p);
}
function kbUp(e) {
  const p = pressing.get(e.pointerId);
  if (!p) return;
  pressing.delete(e.pointerId);
  p.el.classList.remove("down");
  clearTimeout(p.timer);
  clearTimeout(p.longTimer);
  if (e.type === "pointercancel") return;
  const key = p.key;
  if (MODS.includes(key)) { if (!p.long) tapMod(key); return; }
  if (key === "caps") { caps = !caps; paintMods(); return; }
  if (!p.repeated) pressKey(key);
  afterKey();
}

// keep getting the finger's moves when it slides off the element (may throw for a pointer the browser no longer has)
function capture(el, id) { try { el.setPointerCapture(id); } catch {} }

// ---------------------------------------------------------------- trackpad
const pad = { pts: new Map(), start: 0, max: 0, moved: 0, last: 0, lastTapEnd: 0, armDrag: false, dragging: false,
  holdTimer: null, three: { dx: 0, dy: 0 }, scrollAcc: { dx: 0, dy: 0 } };
function centroid() {
  let x = 0, y = 0;
  for (const p of pad.pts.values()) { x += p.x; y += p.y; }
  const n = pad.pts.size || 1;
  return { x: x / n, y: y / n };
}
function startDrag() {
  if (pad.dragging) return;
  pad.dragging = true;
  $("#pad").classList.add("drag");
  send({ t: "down", b: "left", mods: activeMods() });
}
function padDown(e) {
  e.preventDefault();
  capture($("#pad"), e.pointerId);
  const now = performance.now();
  if (pad.pts.size === 0) {
    pad.start = now; pad.max = 0; pad.moved = 0; pad.three = { dx: 0, dy: 0 };
    pad.armDrag = now - pad.lastTapEnd < 280;            // tap, then touch again and move = drag
    clearTimeout(pad.holdTimer);
    pad.holdTimer = setTimeout(() => { if (pad.pts.size === 1 && pad.moved < 6) startDrag(); }, 650);
    // finger resting on the pad = about to aim: the magnifier comes up (auto)
    pad.v = null;
    pad.slowMs = 0;
  }
  pad.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pad.max = Math.max(pad.max, pad.pts.size);
  stopGlide();
  if (pad.pts.size === 2) {
    const [a, b] = [...pad.pts.values()];
    pad.pinchD0 = Math.hypot(a.x - b.x, a.y - b.y);
    pad.mode2 = null;
    pad.sv = { x: 0, y: 0 };
  }
  pad.c = centroid();
  pad.last = now;
}
function padMove(e) {
  const p = pad.pts.get(e.pointerId);
  if (!p) return;
  e.preventDefault();
  p.x = e.clientX; p.y = e.clientY;
  const c = centroid();
  const dx = c.x - pad.c.x, dy = c.y - pad.c.y;
  pad.c = c;
  const dist = Math.hypot(dx, dy);
  pad.moved += dist;
  const now = performance.now(), dt = Math.max(1, now - pad.last);
  pad.last = now;
  const n = pad.pts.size;
  if (n === 1) {
    if (pad.armDrag && !pad.dragging && pad.moved > 4) startDrag();
    // speed, smoothed over the last few events (one jittery event no longer jerks the pointer)
    pad.v = pad.v == null ? dist / dt : pad.v * 0.6 + (dist / dt) * 0.4;
    const v = pad.v;                                       // css px per ms
    // acceleration like a Mac trackpad: slow = about 1:1 and exact, faster = more, smoothly (no sudden jumps)
    const t = Math.min(1, Math.max(0, (v - 0.06) / 1.4));
    let gain = S.speed * (0.6 + 2.6 * t * t * (3 - 2 * t));
    // magnifier (auto): only after the finger has moved slowly for a moment (aiming), gone on a fast sweep
    pad.slowMs = v < 0.3 ? (pad.slowMs || 0) + dt : 0;
    if (pad.slowMs > 220) aimSoon(800);
    else if (v > 1.1) loupe.until = 0;
    if (S.precise && loupeShown()) gain *= v < 0.3 ? 0.55 : 0.8;   // finer steps while it shows
    send({ t: "move", dx: dx * gain, dy: dy * gain });
  } else if (n === 2) {
    const [a, b] = [...pad.pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (!pad.mode2) {                                       // which is it: fingers apart / together, or both moving?
      if (Math.abs(d - pad.pinchD0) > 22) { pad.mode2 = "pinch"; pad.pinchRef = d; }
      else if (pad.moved > 10) pad.mode2 = "scroll";
    }
    if (pad.mode2 === "pinch") {                            // ⌘+ / ⌘−: zooms Safari, Chrome, Preview, Maps…
      if (d / pad.pinchRef > 1.28) { send({ t: "action", a: "zoomIn" }); pad.pinchRef = d; }
      else if (d / pad.pinchRef < 0.78) { send({ t: "action", a: "zoomOut" }); pad.pinchRef = d; }
    } else if (pad.mode2 === "scroll") {
      const k = S.scroll * 2 * (S.invert ? -1 : 1);
      send({ t: "scroll", dx: dx * k, dy: dy * k });
      const f = 16 / dt;                                    // per 60 Hz frame, for the glide after lift-off
      pad.sv = { x: pad.sv.x * 0.6 + dx * k * f * 0.4, y: pad.sv.y * 0.6 + dy * k * f * 0.4 };
    }
  } else {
    pad.three.dx += dx; pad.three.dy += dy;
  }
}
function padUp(e) {
  if (!pad.pts.has(e.pointerId)) return;
  pad.pts.delete(e.pointerId);
  if (pad.pts.size) { pad.c = centroid(); return; }
  clearTimeout(pad.holdTimer);
  const now = performance.now();
  const tap = now - pad.start < 260 && pad.moved < 10;
  if (pad.dragging) {
    pad.dragging = false;
    $("#pad").classList.remove("drag");
    send({ t: "up", b: "left", mods: activeMods() });
    afterKey();
  } else if (pad.max >= 4) {                                // four fingers: switch apps (like ⌘Tab), up = desktop
    const { dx, dy } = pad.three;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) send({ t: "action", a: dx < 0 ? "appNext" : "appPrev" });
    else if (dy < -50) send({ t: "action", a: "showDesktop" });
    else if (dy > 50) send({ t: "action", a: "apps" });
  } else if (pad.max >= 3) {
    const { dx, dy } = pad.three;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) send({ t: "action", a: dx < 0 ? "desktopRight" : "desktopLeft" });
    else if (dy < -50) send({ t: "action", a: "mission" });
    else if (dy > 50) send({ t: "action", a: "apps" });
  } else if (pad.max === 2 && pad.mode2 === "scroll" && now - pad.last < 80) {
    glide(pad.sv.x, pad.sv.y);                              // momentum: the page keeps going, slowing down
  } else if (tap && !(pad.max === 2 && pad.mode2)) {
    send({ t: "click", b: pad.max === 2 ? "right" : "left", mods: activeMods() });
    afterKey();
    if (pad.max === 1) pad.lastTapEnd = now;
  }
}

let glideRaf = 0;
function stopGlide() { cancelAnimationFrame(glideRaf); glideRaf = 0; }
function glide(vx, vy) {
  stopGlide();
  if (Math.hypot(vx, vy) < 2) return;
  const step = () => {
    vx *= 0.94; vy *= 0.94;
    if (Math.hypot(vx, vy) < 0.6) { glideRaf = 0; return; }
    send({ t: "scroll", dx: vx, dy: vy });
    glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- the screen itself: tap = click there
const scr = { id: null, x: 0, y: 0, t: 0, dragging: false, timer: null, aim: false };
function screenPoint(e) {
  const r = $("#frame").getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
// tap = click there · move right away = drag · hold, then slide = aim with the magnifier above your finger, lift = click
// two fingers on the picture: zoom in / move around it on the phone (the Mac is not touched), 1× under the screen resets
const view = { s: 1, x: 0, y: 0 };
const scrPts = new Map();
let viewG = null;
function applyView() {
  const el = $("#screen"), w = el.clientWidth, h = el.clientHeight;
  view.s = Math.min(6, Math.max(1, view.s));
  view.x = Math.min(0, Math.max(w - w * view.s, view.x));
  view.y = Math.min(0, Math.max(h - h * view.s, view.y));
  $("#view").style.transform = view.s > 1.001 ? `translate(${view.x}px, ${view.y}px) scale(${view.s})` : "";
  $("#cursor").style.transform = `translate(-1px, -1px) scale(${1 / view.s})`;   // the pointer keeps its size
  $("#viewReset").hidden = view.s <= 1.001;
  $("#viewReset").textContent = `${view.s.toFixed(1)}× ⟲`;
}
function scrLocal(p) { const r = $("#screen").getBoundingClientRect(); return { x: p.x - r.left, y: p.y - r.top }; }
function startViewGesture() {
  const [a, b] = [...scrPts.values()];
  viewG = { s: view.s, x: view.x, y: view.y, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, c: scrLocal({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
}
function moveViewGesture() {
  const [a, b] = [...scrPts.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y), c = scrLocal({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const s = Math.min(6, Math.max(1, viewG.s * d / viewG.d));
  const px = (viewG.c.x - viewG.x) / viewG.s, py = (viewG.c.y - viewG.y) / viewG.s;   // the picture point under the fingers
  Object.assign(view, { s, x: c.x - px * s, y: c.y - py * s });
  applyView();
}
function scrDown(e) {
  scrPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (scrPts.size === 2) {                                   // a second finger: this is a zoom, not a click
    e.preventDefault();
    capture($("#screen"), e.pointerId);
    clearTimeout(scr.timer);
    if (scr.dragging) send({ t: "up", b: "left" });
    scr.dragging = false; scr.aim = false; loupe.finger = null; scr.cancel = true;
    startViewGesture();
    return;
  }
  if (scr.id !== null || scrPts.size > 2) return;
  scr.cancel = false;
  e.preventDefault();
  capture($("#screen"), e.pointerId);
  Object.assign(scr, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dragging: false, aim: false });
  const p = screenPoint(e);
  send({ t: "moveTo", x: p.x, y: p.y, d: S.display });
  scr.timer = setTimeout(() => {
    if (scr.id === null || scr.dragging || S.loupe === "off") return;
    scr.aim = true;
    loupe.finger = { x: scr.x, y: scr.y };
  }, 300);
}
function scrMove(e) {
  if (scrPts.has(e.pointerId)) scrPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (viewG) { if (scrPts.size >= 2) { e.preventDefault(); moveViewGesture(); } return; }
  if (e.pointerId !== scr.id || scr.cancel) return;
  e.preventDefault();
  const p = screenPoint(e);
  if (scr.aim) {
    loupe.finger = { x: e.clientX, y: e.clientY };
    send({ t: "moveTo", x: p.x, y: p.y, d: S.display });
    return;
  }
  if (!scr.dragging && Math.hypot(e.clientX - scr.x, e.clientY - scr.y) > 8) {
    scr.dragging = true;
    clearTimeout(scr.timer);
    send({ t: "down", b: "left", mods: activeMods() });
  }
  if (scr.dragging) send({ t: "moveTo", x: p.x, y: p.y, d: S.display });
}
function scrUp(e) {
  scrPts.delete(e.pointerId);
  if (viewG) { if (scrPts.size < 2) viewG = null; if (!scrPts.size) scr.id = null; return; }
  if (e.pointerId !== scr.id) return;
  if (scr.cancel) { scr.id = null; return; }
  scr.id = null;
  clearTimeout(scr.timer);
  const wasAim = scr.aim;
  scr.aim = false;
  loupe.finger = null;
  if (wasAim) aimSoon(500);                                   // keep it a moment: you see where the click went
  if (e.type === "pointercancel") { if (scr.dragging) send({ t: "up", b: "left" }); return; }
  if (scr.dragging) send({ t: "up", b: "left", mods: activeMods() });
  else send({ t: "click", b: "left", mods: activeMods() });
  afterKey();
}

// ---------------------------------------------------------------- magnifier
// A round loupe around the pointer, with a cross on the exact spot a click lands. Its picture is a sharp piece cut
// from the Mac's own screen (Retina pixels, sent on its own track at up to 20 a second); until one arrives, or on an
// older server, it magnifies the stream picture.
const loupe = { serverZoom: false, sentOn: false, sentSide: 0, until: 0, finger: null, sharp: null, sharpR: null,
  sharpAt: 0, shown: false };
const lctx = $("#loupeC").getContext("2d");
function aimSoon(ms) { if (S.loupe === "auto") loupe.until = Math.max(loupe.until, performance.now() + ms); }
function loupeShown() { return loupe.shown; }
function loupeSize() { return Math.round(Math.min(180, Math.max(104, $("#screen").clientHeight * 0.44))); }
async function onZoom(head, bytes, ws) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    if (loupe.sharp && loupe.sharp.close) loupe.sharp.close();
    loupe.sharp = bmp;
    loupe.sharpR = head.r;
    loupe.sharpAt = performance.now();
  } catch {}
  if (ws.readyState === 1) ws.send('{"t":"zack"}');
}
// drawImage with a source area that may run past the image's edge (pointer near a screen edge): clip it, and
// draw only that part, in the right place (Safari draws nothing for an out-of-bounds source)
function drawClipped(img, iw, ih, sx, sy, sw, sh, L) {
  const x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(iw, sx + sw), y1 = Math.min(ih, sy + sh);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = L / sw, ky = L / sh;
  lctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * kx, (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}
function drawArrow(c, x, y, k) {
  c.save();
  c.translate(x, y);
  c.scale(k, k);
  c.beginPath();
  c.moveTo(0, 0); c.lineTo(0, 16); c.lineTo(4, 12.5); c.lineTo(7, 19); c.lineTo(9.6, 17.8); c.lineTo(6.8, 11.5); c.lineTo(12, 11.5);
  c.closePath();
  c.fillStyle = "#000"; c.strokeStyle = "#fff"; c.lineWidth = 1.2;
  c.fill(); c.stroke();
  c.restore();
}
function loupeTick() {
  requestAnimationFrame(loupeTick);
  const now = performance.now();
  const ready = dev() && live.sw && canvas.width > 1;
  // a finger still resting on the trackpad keeps it up once it showed
  if (S.loupe === "auto" && loupe.shown && pad.pts.size === 1 && !pad.dragging && now < loupe.until + 50) loupe.until = now + 400;
  const show = !!ready && S.loupe !== "off" && (S.loupe === "on" || scr.aim || now < loupe.until);
  const el = $("#loupe");
  if (show !== loupe.shown) { loupe.shown = show; el.hidden = !show; }
  const size = loupeSize();
  const scrEl = $("#screen"), sr = scrEl.getBoundingClientRect(), fr = canvas.getBoundingClientRect();
  // what the loupe covers, in Mac points and as a share of the screen
  const sidePts = (size / S.zoom) * (live.sw / Math.max(1, fr.width));
  const want = show && loupe.serverZoom && live.ws && live.ws.readyState === 1;
  if (want !== loupe.sentOn || (want && Math.abs(sidePts - loupe.sentSide) > 2)) {
    live.ws && live.ws.readyState === 1 && live.ws.send(JSON.stringify({ t: "zoom", on: want, side: sidePts,
      px: Math.min(720, Math.round(size * (window.devicePixelRatio || 1))) }));
    loupe.sentOn = want;
    loupe.sentSide = sidePts;
  }
  if (!show) return;
  // place it: above the finger when aiming on the screen, otherwise above the pointer; below when there is no room
  const ax = loupe.finger ? loupe.finger.x - sr.left : fr.left - sr.left + live.cursor.x * fr.width;
  const ay = loupe.finger ? loupe.finger.y - sr.top : fr.top - sr.top + live.cursor.y * fr.height;
  const gap = loupe.finger ? 46 : 22;
  const roomAbove = ay - gap - size > 2;
  if (loupe.side === "below" ? roomAbove && ay - gap - size > 24 : !roomAbove) loupe.side = roomAbove ? "above" : "below";
  let cy = loupe.side === "below" ? ay + size / 2 + gap : ay - size / 2 - gap;
  const cx = Math.min(sr.width - size / 2 - 2, Math.max(size / 2 + 2, ax));
  cy = Math.min(sr.height - size / 2 - 2, Math.max(size / 2 + 2, cy));
  el.style.setProperty("--lz", size + "px");
  el.style.left = cx + "px";
  el.style.top = cy + "px";
  // draw: the view is centred on the pointer (as the phone predicts it, so it follows the finger at once)
  const L = 300, vw = sidePts / live.sw, vh = sidePts / live.sh;
  const vx = live.cursor.x - vw / 2, vy = live.cursor.y - vh / 2;
  lctx.fillStyle = "#000";
  lctx.fillRect(0, 0, L, L);
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  const R = loupe.sharpR, img = loupe.sharp;
  const sharp = img && R && now - loupe.sharpAt < 700 && vx >= R[0] - vw * 0.35 && vy >= R[1] - vh * 0.35
    && vx + vw <= R[0] + R[2] + vw * 0.35 && vy + vh <= R[1] + R[3] + vh * 0.35;
  if (sharp) {
    const kx = img.width / R[2], ky = img.height / R[3];
    drawClipped(canvas, canvas.width, canvas.height, vx * canvas.width, vy * canvas.height, vw * canvas.width, vh * canvas.height, L);
    drawClipped(img, img.width, img.height, (vx - R[0]) * kx, (vy - R[1]) * ky, vw * kx, vh * ky, L);
  } else {
    drawClipped(canvas, canvas.width, canvas.height, vx * canvas.width, vy * canvas.height, vw * canvas.width, vh * canvas.height, L);
  }
  drawArrow(lctx, L / 2, L / 2, Math.min(3, Math.max(1.2, S.zoom * 0.55)));
  el.querySelector(".lz").textContent = `${S.zoom}×${sharp ? " · tajam" : ""}`;
}
function paintLoupeBtn() {
  const b = $("#loupeBtn");
  b.classList.toggle("on", S.loupe === "on");
  b.classList.toggle("auto", S.loupe === "auto");
  b.title = { auto: "Kaca pembesar: auto (muncul pas ngepas)", on: "Kaca pembesar: selalu nyala", off: "Kaca pembesar: mati" }[S.loupe];
}

// ---------------------------------------------------------------- phone keyboard (Aa): fast text, dictation
function imeSetup() {
  const ime = $("#ime");
  ime.addEventListener("beforeinput", e => {
    const t = e.inputType;
    if (t === "insertText" || t === "insertReplacementText" || t === "insertFromPaste") {
      const s = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
      if (s) send({ t: "text", s });
    } else if (t === "insertLineBreak" || t === "insertParagraph") send({ t: "key", k: "return" });
    else if (t.startsWith("deleteContentBackward") || t === "deleteWordBackward") send({ t: "key", k: "delete", mods: t === "deleteWordBackward" ? ["option"] : [] });
    else if (t.startsWith("deleteContentForward")) send({ t: "key", k: "forwarddelete" });
    else return;
    e.preventDefault();
  });
  ime.addEventListener("input", () => { if (ime.value) { send({ t: "text", s: ime.value }); ime.value = ""; } });
  ime.addEventListener("blur", () => document.querySelector('[data-act="ime"]').classList.remove("on"));
}

// ---------------------------------------------------------------- Touch Bar row: follows the app in front on the Mac
const B = (label, act, title) => ({ label, act, title });
const K = (label, key, mods, title) => ({ label, key, mods, title });
const TOUCHBAR = [
  { match: /terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|hyper|tabby|vscode|code|cursor|xcode|zed|sublime|nova|jetbrains|pycharm|intellij/i,
    keys: [K("esc", "escape"), K("⇥", "tab", [], "Tab"), K("◀", "left"), K("▲", "up"), K("▼", "down"), K("▶", "right"),
      K("⌃C", "c", ["control"], "Stop (Ctrl+C)"), K("⌃D", "d", ["control"], "Ctrl+D"), K("⌃R", "r", ["control"], "Cari riwayat (Ctrl+R)"),
      K("⌘K", "k", ["command"], "Bersihin layar"), K("⌃A", "a", ["control"], "Awal baris"), K("⌃E", "e", ["control"], "Akhir baris")] },
  { match: /safari|chrome|firefox|brave|arc|edge|opera|vivaldi|orion/i, keys: [B("◀︎", "back", "Kembali"), B("▶︎", "forward", "Maju"),
    B("⟳", "reload", "Muat ulang"), B("＋", "newTab", "Tab baru"), B("✕", "closeTab", "Tutup tab"), B("A−", "zoomOut", "Perkecil"), B("A+", "zoomIn", "Perbesar")] },
  { match: /music|spotify|itunes|podcasts|tv$|vlc|iina|quicktime/i, keys: [B("⏮", "prevtrack", "Sebelumnya"), B("⏯", "playpause", "Putar / jeda"),
    B("⏭", "nexttrack", "Berikutnya"), B("🔉", "voldown", "Volume turun"), B("🔊", "volup", "Volume naik"), B("🔇", "mute", "Mute")] },
  { match: /keynote|powerpoint|slides/i, keys: [B("◀ slide", "prevSlide", "Slide sebelumnya"), B("slide ▶", "nextSlide", "Slide berikutnya"),
    B("⏯", "playpause", "Putar / jeda"), B("🔉", "voldown"), B("🔊", "volup")] },
  { match: /finder/i, keys: [B("◀︎", "back", "Kembali"), B("▶︎", "forward", "Maju"), B("📁＋", "newFolder", "Folder baru"),
    B("⌕", "spotlight", "Spotlight"), B("▦", "mission", "Mission Control")] },
  { match: /./, keys: [B("▦", "mission", "Mission Control"), B("◀︎", "desktopLeft", "Desktop kiri"), B("▶︎", "desktopRight", "Desktop kanan"),
    B("⌕", "spotlight", "Spotlight"), B("⏯", "playpause", "Putar / jeda"), B("🔉", "voldown"), B("🔊", "volup"), B("🔒", "lock", "Kunci Mac")] },
];
let frontApp = { id: "", name: "" };
function renderTouchBar(app) {
  if (app) frontApp = app;
  const key = `${frontApp.id} ${frontApp.name}`;
  const set = TOUCHBAR.find(t => t.match.test(key)) || TOUCHBAR[TOUCHBAR.length - 1];
  $("#ctx").innerHTML = (frontApp.name ? `<span class="app">${escapeHtml(frontApp.name)}</span>` : "")
    + set.keys.map(k => k.key
      ? `<button data-tkey="${escapeHtml(k.key)}" data-mods="${(k.mods || []).join(",")}" title="${escapeHtml(k.title || k.key)}">${k.label}</button>`
      : `<button data-act="${k.act}" title="${escapeHtml(k.title || k.label)}">${k.label}</button>`).join("");
}

// ---------------------------------------------------------------- clipboard ⇄
// Mac → phone: a copy on the Mac shows a bar here; "Salin ke HP" puts it on the phone's clipboard.
// Phone → Mac: 📋 opens a box to paste into (a plain http:// page may not read the phone's clipboard by itself).
let macClip = "";
function onMacClip(text) {
  macClip = text;
  $("#clipbar .t").textContent = "📋 Mac: " + text.replace(/\s+/g, " ").slice(0, 120);
  $("#clipbar").hidden = false;
  $("#clipLast").textContent = "Terakhir di-copy di Mac: " + text.slice(0, 300);
  clearTimeout(onMacClip.t);
  onMacClip.t = setTimeout(() => ($("#clipbar").hidden = true), 12000);
}
async function copyToPhone(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement("textarea");                 // works without HTTPS, inside a tap
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;font-size:16px";
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}
async function openClipSheet() {
  $("#clipSheet").hidden = false;
  const box = $("#clipIn");
  box.value = "";
  try { const t = await navigator.clipboard.readText(); if (t) box.value = t; } catch {}   // only on HTTPS
  box.focus();
}
function sendClip(paste) {
  const text = $("#clipIn").value;
  if (!text) { toast("Kosong: tempel teksnya dulu"); return; }
  const ws = live.ws;
  if (!ws || ws.readyState !== 1) { toast("Belum nyambung ke Mac"); return; }
  ws.send(JSON.stringify({ t: "clipset", s: text, paste }));
  $("#clipSheet").hidden = true;
  toast(paste ? "📋 Ditempel di Mac" : "📋 Masuk clipboard Mac (⌘V di Mac)");
}

// ---------------------------------------------------------------- files → the Mac's Downloads
function uploadFiles(files) {
  const list = [...files];
  let i = 0;
  const next = () => {
    if (i >= list.length) return;
    const f = list[i++];
    const xhr = new XMLHttpRequest();
    xhr.open("POST", api("/api/upload", `&name=${encodeURIComponent(f.name)}`));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = e => { if (e.lengthComputable) toast(`📎 ${f.name}: ${Math.round(e.loaded * 100 / e.total)}%`, 4000); };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      toast(j.ok ? `✓ ${j.name} → Downloads Mac` : `✗ ${f.name}: ${j.error || xhr.status}`, 3500);
      next();
    };
    xhr.onerror = () => { toast(`✗ ${f.name}: koneksi putus`, 3500); next(); };
    xhr.send(f);
  };
  next();
}

// ---------------------------------------------------------------- key click sound (the phone can't vibrate from a web page)
let audio = null;
function click(kind) {
  if (!S.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const t = audio.currentTime, len = kind === "space" ? 0.03 : 0.018;
    const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * len), audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
    f.type = "bandpass"; f.frequency.value = kind === "space" ? 1400 : 2600; f.Q.value = 0.9;
    g.gain.setValueAtTime(0.35, t);
    src.buffer = buf;
    src.connect(f).connect(g).connect(audio.destination);
    src.start(t);
  } catch {}
  try { navigator.vibrate && navigator.vibrate(6); } catch {}        // Android: a short tick
}

// ---------------------------------------------------------------- a Bluetooth / Magic Keyboard paired to the phone
// Keys typed on it go to the Mac (by physical key, so ⌘ ⌥ ⌃ shortcuts work as on the Mac).
const CODE_KEYS = { Space: "space", Enter: "return", NumpadEnter: "return", Backspace: "delete", Tab: "tab", Escape: "escape",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Delete: "forwarddelete", Home: "home", End: "end",
  PageUp: "pageup", PageDown: "pagedown", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`" };
function codeToKey(code) {
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (m) return m[1];
  m = /^F(\d{1,2})$/.exec(code);
  if (m && +m[1] <= 20) return "f" + m[1];
  return null;
}
function hardwareKeys() {
  document.addEventListener("keydown", e => {
    const t = e.target;
    if (!dev() || t.closest && (t.closest("input, textarea, select") || t.closest("#sheet, #clipSheet"))) return;
    const k = codeToKey(e.code);
    if (!k) return;                                               // a lone modifier, media key, …
    e.preventDefault();
    const mods = [];
    if (e.metaKey) mods.push("command");
    if (e.ctrlKey) mods.push("control");
    if (e.altKey) mods.push("option");
    if (e.shiftKey) mods.push("shift");
    send({ t: "key", k, mods });
  });
}

// ---------------------------------------------------------------- settings sheet
function renderSheet() {
  const list = $("#devList");
  list.innerHTML = S.devices.length ? "" : '<p class="muted">Belum ada Mac. Jalanin <b>python3 server.py</b> di Mac, buka link yang dia print di HP ini.</p>';
  S.devices.forEach((d, i) => {
    const row = document.createElement("div");
    row.className = "dev" + (i === S.cur ? " cur" : "");
    row.innerHTML = `<div class="nm">${escapeHtml(d.name)}<small>${escapeHtml(d.url)}</small></div>
      <button class="use" data-use="${i}">${i === S.cur ? "Dipakai" : "Pakai"}</button><button data-del="${i}">Hapus</button>`;
    list.append(row);
  });
  $("#setQuality").value = S.quality;
  $("#setFps").value = String(S.fps);
  $("#setFrow").checked = S.frow;
  $("#setSpeed").value = S.speed;
  $("#setScroll").value = S.scroll;
  $("#setInvert").checked = S.invert;
  $("#setSound").checked = S.sound;
  $("#setLockLeave").checked = S.lockLeave;
  $("#setLoupe").value = S.loupe;
  $("#setZoom").value = String(S.zoom);
  $("#setPrecise").checked = S.precise;
}
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function bind() {
  const kb = $("#kb");
  kb.addEventListener("pointerdown", kbDown);
  kb.addEventListener("pointerup", kbUp);
  kb.addEventListener("pointercancel", kbUp);
  kb.addEventListener("contextmenu", e => e.preventDefault());

  const p = $("#pad");
  p.addEventListener("pointerdown", padDown);
  p.addEventListener("pointermove", padMove);
  p.addEventListener("pointerup", padUp);
  p.addEventListener("pointercancel", padUp);
  p.addEventListener("contextmenu", e => e.preventDefault());

  const s = $("#screen");
  s.addEventListener("pointerdown", scrDown);
  s.addEventListener("pointermove", scrMove);
  s.addEventListener("pointerup", scrUp);
  s.addEventListener("pointercancel", scrUp);
  s.addEventListener("contextmenu", e => e.preventDefault());

  // Touch Bar keys (Terminal row): tap = once, hold = repeats like a real key
  const tb = { timer: null };
  const tbStop = () => { clearTimeout(tb.timer); tb.timer = null; };
  $("#ctx").addEventListener("pointerdown", e => {
    const b = e.target.closest("[data-tkey]");
    if (!b) return;
    e.preventDefault();
    click("key");
    const ev = { t: "key", k: b.dataset.tkey, mods: (b.dataset.mods || "").split(",").filter(Boolean).concat(activeMods()) };
    send({ ...ev });
    afterKey();
    tbStop();
    tb.timer = setTimeout(function rep() { send({ ...ev }); tb.timer = setTimeout(rep, 55); }, 380);
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) $("#ctx").addEventListener(t, tbStop);
  $("#tools").addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "ime") { b.classList.add("on"); $("#ime").focus(); return; }
    if (b.dataset.act === "clip") { macClip && !$("#clipbar").hidden ? $("#clipbar").hidden = false : openClipSheet(); return; }
    if (b.dataset.act === "file") { $("#fileIn").click(); return; }
    if (b.dataset.act === "loupe") {
      S.loupe = { auto: "on", on: "off", off: "auto" }[S.loupe] || "auto";
      store.set("loupe", S.loupe);
      paintLoupeBtn();
      toast({ auto: "🔍 Auto: muncul pas lagi ngepas", on: "🔍 Selalu nyala", off: "🔍 Mati" }[S.loupe]);
      return;
    }
    send({ t: "action", a: b.dataset.act });
  });
  $("#devBtn").onclick = () => {
    if (S.devices.length === 2) return switchDevice(1 - S.cur);       // two Macs: one tap flips
    $("#sheet").hidden = false; renderSheet();
  };
  $("#gearBtn").onclick = () => { $("#sheet").hidden = false; renderSheet(); };
  $("#closeSheet").onclick = () => ($("#sheet").hidden = true);
  $("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
  $("#dispBtn").onclick = () => {
    const n = (S.info?.displays || []).length || 1;
    S.display = (S.display + 1) % n;
    applyInfo(S.info);
    sendCfg();
  };
  // full screen: keyboard and trackpad away, the bar under the screen stays (⤡ brings them back)
  const full = on => {
    document.body.classList.toggle("full", on);
    $("#fullBtn").textContent = on ? "⤡ ⌨︎" : "⤢";
    $("#fullBtn").title = on ? "Balik ke keyboard + trackpad" : "Layar penuh";
    fitScreen();
    setTimeout(sendCfg, 350);                                  // bigger picture: ask for a sharper one
  };
  $("#fullBtn").onclick = () => full(!document.body.classList.contains("full"));
  $("#unfull").onclick = () => full(false);
  $("#devList").addEventListener("click", e => {
    const u = e.target.closest("[data-use]"), d = e.target.closest("[data-del]");
    if (u) switchDevice(+u.dataset.use);
    if (d && confirm("Hapus Mac ini dari daftar?")) {
      S.devices.splice(+d.dataset.del, 1);
      store.set("devices", S.devices);
      switchDevice(Math.min(S.cur, S.devices.length - 1), true);
      renderSheet();
    }
  });
  $("#addForm").onsubmit = async e => {
    e.preventDefault();
    try {
      const u = new URL($("#addLink").value.trim());
      const token = u.searchParams.get("token");
      if (!token) throw new Error("link-nya nggak ada ?token=");
      const r = await fetch(`${u.origin}/api/info?token=${encodeURIComponent(token)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      addDevice(u.origin, token, j.name, true);
      $("#addLink").value = "";
      toast("✓ " + j.name + " ditambah");
    } catch (err) { toast("✗ " + err.message, 3500); }
  };
  const setting = (id, key, conv, after) => $(id).addEventListener("change", e => {
    S[key] = conv(e.target.type === "checkbox" ? e.target.checked : e.target.value);
    store.set(key, S[key]);
    after && after();
  });
  setting("#setQuality", "quality", String, sendCfg);
  setting("#setFps", "fps", Number, sendCfg);
  setting("#setFrow", "frow", Boolean, buildKeyboard);
  setting("#setSpeed", "speed", Number);
  setting("#setScroll", "scroll", Number);
  setting("#setInvert", "invert", Boolean);
  setting("#setSound", "sound", Boolean);
  setting("#setLockLeave", "lockLeave", Boolean, sendCfg);
  $("#viewReset").onclick = () => { Object.assign(view, { s: 1, x: 0, y: 0 }); applyView(); };
  $("#fileIn").addEventListener("change", e => { if (e.target.files.length) uploadFiles(e.target.files); e.target.value = ""; });
  $("#clipCopy").onclick = async () => {
    const ok = await copyToPhone(macClip);
    toast(ok ? "📋 Tersalin di HP" : "Nggak bisa salin otomatis: tahan teks di ⚙ → Clipboard");
    $("#clipbar").hidden = true;
  };
  $("#clipClose").onclick = () => ($("#clipbar").hidden = true);
  $("#clipSheetClose").onclick = () => ($("#clipSheet").hidden = true);
  $("#clipSend").onclick = () => sendClip(false);
  $("#clipPaste").onclick = () => sendClip(true);
  hardwareKeys();
  window.addEventListener("resize", () => { fitScreen(); Object.assign(view, { s: 1, x: 0, y: 0 }); applyView(); });
  setting("#setLoupe", "loupe", String, paintLoupeBtn);
  setting("#setZoom", "zoom", Number);
  setting("#setPrecise", "precise", Boolean);
  // app in the background: let go of keys, close the connection (the Mac stops capturing); back: reconnect
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { releaseHeld(); disconnect(); } else if (dev()) connect();
  });
  let rz = null;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(sendCfg, 300); });
  // stop iOS from scrolling / zooming the page itself
  document.addEventListener("touchmove", e => { if (!e.target.closest("#sheet, #clipSheet")) e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturestart", e => e.preventDefault());
}

adoptLinkFromUrl();
buildKeyboard();
imeSetup();
bind();
if (dev()) switchDevice(S.cur, true);
else { setStatus("Belum ada Mac. Jalanin python3 server.py di Mac, buka link yang dia print di HP ini."); $("#sheet").hidden = false; renderSheet(); }
placeCursor();
