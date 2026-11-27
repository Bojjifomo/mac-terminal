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
  quality: store.get("quality", "mid"),
  fps: store.get("fps", 24),
  frow: store.get("frow", false),
  speed: store.get("speed", 1.6),
  scroll: store.get("scroll", 1.4),
  invert: store.get("invert", false),
  display: 0,
  info: null,
};
const QUALITY = { low: { dpr: 1, q: 0.45 }, mid: { dpr: 1.5, q: 0.6 }, high: { dpr: 2, q: 0.72 } };
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
  frameState.since = "";
  $("#devName").textContent = dev().name;
  $("#label").textContent = dev().name;
  loadInfo();
  if (!quiet) toast("→ " + dev().name);
  renderSheet();
}
async function loadInfo() {
  if (!dev()) return;
  try {
    const r = await fetch(api("/api/info"));
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || r.status);
    S.info = j;
    dev().name = j.name;
    store.set("devices", S.devices);
    $("#devName").textContent = j.name;
    $("#label").textContent = j.name;
    $("#dispBtn").hidden = (j.displays || []).length < 2;
    $("#dispBtn").textContent = "▣ " + (S.display + 1);
    const d = (j.displays || [])[S.display];
    if (d) $("#screen").style.aspectRatio = `${d.w} / ${d.h}`;
    $("#cursor").style.display = j.cursorInImage ? "none" : "block";
  } catch (e) {
    setStatus(`Nggak nyambung ke ${dev().name}: ${e.message}. Server di Mac nyala? Tailscale nyala?`);
  }
}

// ---------------------------------------------------------------- screen frames
const frameState = { since: "", frames: 0, t0: performance.now(), lastUrl: null, okAt: 0 };
function setStatus(msg) {
  const s = $("#status");
  if (msg) { s.textContent = msg; s.classList.remove("hide"); } else s.classList.add("hide");
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function frameLoop() {
  const img = $("#frame");
  for (;;) {
    if (!dev() || document.hidden) { await sleep(400); continue; }
    const t0 = performance.now();
    const qq = QUALITY[S.quality] || QUALITY.mid;
    const w = Math.round(Math.min(3200, $("#screen").clientWidth * Math.min(window.devicePixelRatio || 1, qq.dpr)));
    try {
      const r = await fetch(api("/api/frame", `&w=${w}&q=${qq.q}&d=${S.display}&since=${frameState.since}`), { cache: "no-store" });
      if (r.status === 200) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        img.src = url;
        try { await img.decode(); } catch {}
        if (frameState.lastUrl) URL.revokeObjectURL(frameState.lastUrl);
        frameState.lastUrl = url;
        frameState.since = r.headers.get("X-Frame") || "";
        frameState.frames++;
      } else if (r.status !== 204) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "HTTP " + r.status);
      }
      const c = (r.headers.get("X-Cursor") || "").split(",").map(Number);
      if (c.length === 2 && isFinite(c[0])) { const cur = $("#cursor"); cur.style.left = c[0] * 100 + "%"; cur.style.top = c[1] * 100 + "%"; }
      frameState.okAt = performance.now();
      setStatus("");
    } catch (e) {
      setStatus(`Nggak nyambung ke ${dev().name}: ${e.message}`);
      await sleep(1200);
    }
    const now = performance.now();
    if (now - frameState.t0 > 1000) {
      $("#fps").textContent = `${Math.round(frameState.frames * 1000 / (now - frameState.t0))} fps`;
      frameState.frames = 0;
      frameState.t0 = now;
    }
    const wait = 1000 / S.fps - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
  }
}

// ---------------------------------------------------------------- input queue
// Moves / scrolls that pile up while a request is on its way are merged into one, so the pointer never lags behind.
const queue = [];
let sending = false;
function send(ev) {
  if (!dev()) return;
  const last = queue[queue.length - 1];
  if (last && (ev.t === "move" || ev.t === "scroll") && last.t === ev.t) { last.dx += ev.dx; last.dy += ev.dy; }
  else queue.push(ev);
  flush();
}
async function flush() {
  if (sending || !queue.length) return;
  sending = true;
  const batch = queue.splice(0);
  try {
    const r = await fetch(api("/api/input"), { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(batch) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast("✗ " + (j.error || r.status)); }
  } catch (e) { toast("✗ input: " + e.message); }
  sending = false;
  if (queue.length) flush();
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
    pad.holdTimer = setTimeout(() => { if (pad.pts.size === 1 && pad.moved < 6) startDrag(); }, 480);
  }
  pad.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pad.max = Math.max(pad.max, pad.pts.size);
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
    const v = dist / dt;                                   // css px per ms
    const gain = S.speed * (1 + Math.min(v * 1.3, 4));      // pointer acceleration
    send({ t: "move", dx: dx * gain, dy: dy * gain });
  } else if (n === 2) {
    const k = S.scroll * 2 * (S.invert ? -1 : 1);
    send({ t: "scroll", dx: dx * k, dy: dy * k });
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
  } else if (pad.max >= 3) {
    const { dx, dy } = pad.three;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) send({ t: "action", a: dx < 0 ? "desktopRight" : "desktopLeft" });
    else if (dy < -50) send({ t: "action", a: "mission" });
    else if (dy > 50) send({ t: "action", a: "apps" });
  } else if (tap) {
    send({ t: "click", b: pad.max === 2 ? "right" : "left", mods: activeMods() });
    afterKey();
    if (pad.max === 1) pad.lastTapEnd = now;
  }
}

// ---------------------------------------------------------------- the screen itself: tap = click there
const scr = { id: null, x: 0, y: 0, t: 0, dragging: false, timer: null, long: false };
function screenPoint(e) {
  const r = $("#frame").getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function scrDown(e) {
  if (scr.id !== null) return;
  e.preventDefault();
  capture($("#screen"), e.pointerId);
  Object.assign(scr, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dragging: false, long: false });
  const p = screenPoint(e);
  send({ t: "moveTo", x: p.x, y: p.y, d: S.display });
  scr.timer = setTimeout(() => { scr.long = true; }, 550);
}
function scrMove(e) {
  if (e.pointerId !== scr.id) return;
  e.preventDefault();
  const p = screenPoint(e);
  if (!scr.dragging && Math.hypot(e.clientX - scr.x, e.clientY - scr.y) > 8) {
    scr.dragging = true;
    clearTimeout(scr.timer);
    send({ t: "down", b: "left", mods: activeMods() });
  }
  if (scr.dragging) send({ t: "moveTo", x: p.x, y: p.y, d: S.display });
}
function scrUp(e) {
  if (e.pointerId !== scr.id) return;
  scr.id = null;
  clearTimeout(scr.timer);
  if (e.type === "pointercancel") { if (scr.dragging) send({ t: "up", b: "left" }); return; }
  if (scr.dragging) send({ t: "up", b: "left", mods: activeMods() });
  else send({ t: "click", b: scr.long ? "right" : "left", mods: activeMods() });
  afterKey();
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

  $("#tools").addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "ime") { b.classList.add("on"); $("#ime").focus(); return; }
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
    frameState.since = "";
    loadInfo();
  };
  const full = on => { document.body.classList.toggle("full", on); $("#unfull").hidden = !on; };
  $("#fullBtn").onclick = () => full(true);
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
  setting("#setQuality", "quality", String, () => (frameState.since = ""));
  setting("#setFps", "fps", Number);
  setting("#setFrow", "frow", Boolean, buildKeyboard);
  setting("#setSpeed", "speed", Number);
  setting("#setScroll", "scroll", Number);
  setting("#setInvert", "invert", Boolean);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseHeld(); });
  // stop iOS from scrolling / zooming the page itself
  document.addEventListener("touchmove", e => { if (!e.target.closest("#sheet")) e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturestart", e => e.preventDefault());
}

adoptLinkFromUrl();
buildKeyboard();
imeSetup();
bind();
if (dev()) switchDevice(S.cur, true);
else { setStatus("Belum ada Mac. Jalanin python3 server.py di Mac, buka link yang dia print di HP ini."); $("#sheet").hidden = false; renderSheet(); }
frameLoop();
