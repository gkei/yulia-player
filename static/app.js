/* Hermes Tunes front-end (vanilla JS) */
"use strict";
const $ = (s) => document.querySelector(s);
/* ============ static API shim — no server, all in-browser ============ */
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem("yulia_" + k)); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("yulia_" + k, JSON.stringify(v)); } catch {} },
};
const GH = { owner: "gkei", repo: "yulia-music", ref: "main" };
const pat = () => LS.get("pat", "");
let OVER = LS.get("over", {}) || {};      /* like/dislike overlay: id -> 1 | 0 | -1 */
let RES  = LS.get("res", {})  || {};      /* resolver cache: id -> {audio, art, src, title, ts} */
let _libP = null;
const loadLib = () => _libP || (_libP = fetch("library.json").then(r => {
  if (!r.ok) throw new Error("library.json missing"); return r.json();
}));

const api = async (path, opts = {}) => {
  const [p, qs] = path.split("?");
  const q = new URLSearchParams(qs || "");
  const body = opts.body ? JSON.parse(opts.body) : null;
  const method = opts.method || "GET";

  if (p === "/api/config") return { configured: true, logged_in: true, origin: location.origin };
  if (p === "/api/me") return { display_name: LS.get("name", "Yulia"), product: "Free", offline: true };

  if (p === "/api/playlists") { const lib = await loadLib(); return { items: lib.playlists || [] }; }

  if (p === "/api/liked") {
    const lib = await loadLib();
    const off = +q.get("offset") || 0;
    const all = (lib.liked || []).filter(t => (OVER[t.id] ?? 0) !== -1);
    const items = all.slice(off, off + 50);
    return { items, total: all.length, next_offset: off + 50 < all.length ? off + 50 : null };
  }

  if (p.startsWith("/api/playlists/")) return { items: [], total: 0, next_offset: null };

  if (p === "/api/liked/contains") {
    const lib = await loadLib();
    const inLib = new Set((lib.liked || []).map(t => t.id));
    const results = {};
    for (const id of (q.get("ids") || "").split(",").filter(Boolean)) {
      const ov = OVER[id];
      results[id] = ov === undefined ? inLib.has(id) : ov === 1;
    }
    return { results };
  }

  let m = p.match(/^\/api\/like\/(.+)$/);
  if (m) { OVER[m[1]] = method === "PUT" ? 1 : 0; LS.set("over", OVER); return { ok: true }; }

  m = p.match(/^\/api\/dislike\/(.+)$/);
  if (m) { OVER[m[1]] = -1; LS.set("over", OVER); return { logged_to_disliked: true }; }

  if (p === "/api/music-resolve") return musicResolve(body || {});

  if (p.startsWith("/api/player")) return { is_playing: false, progress_ms: 0, offline: true,
    track: null, shuffle: false, repeat: "off", device: null, volume: 50 };

  throw new Error("static mode: " + p);
};

/* ---- music sources: Deezer (JSONP) -> iTunes (CORS *) ---- */
function deezerSearch(q) {
  return new Promise((res, rej) => {
    const cb = "dz" + Math.random().toString(36).slice(2);
    const s = document.createElement("script");
    let t;
    const cleanup = () => { try { delete window[cb]; } catch {} s.remove(); clearTimeout(t); };
    window[cb] = (d) => { cleanup(); res((d.data || [])[0] || null); };
    s.onerror = () => { cleanup(); rej(new Error("Deezer unreachable")); };
    t = setTimeout(() => { cleanup(); rej(new Error("Deezer timeout")); }, 12000);
    s.src = "https://api.deezer.com/search?output=jsonp&callback=" + cb +
            "&limit=1&q=" + encodeURIComponent(q);
    document.head.appendChild(s);
  });
}
async function itunesSearch(q) {
  const r = await fetch("https://itunes.apple.com/search?entity=song&limit=1&term=" + encodeURIComponent(q));
  if (!r.ok) throw new Error("iTunes " + r.status);
  const d = await r.json();
  return (d.results || [])[0] || null;
}
async function artLookup(q) {
  try { const d = await deezerSearch(q); if (d) return (d.album || {}).cover_xl || ""; } catch {}
  try { const d = await itunesSearch(q); if (d) return (d.artworkUrl100 || "").replace(/\d+x\d+/, "600x600"); } catch {}
  return "";
}
async function musicResolve({ id, q }) {
  if (id && id.startsWith("local:")) {
    const url = await vaultFile(id.slice(6));
    const artwork = await artLookup(q || "");
    return { audio: url, artwork, source: "private vault",
             label: "your private vault — full track", title: (q || "").split(" ")[0] };
  }
  const c = RES[id];
  if (c && Date.now() - c.ts < 7 * 864e5) return { audio: c.audio, artwork: c.art, source: c.src, title: c.title };
  let out = null;
  try {
    const d = await deezerSearch(q);
    if (d && d.preview) out = { audio: d.preview, artwork: (d.album || {}).cover_xl || "",
                                source: "deezer", title: d.title || "" };
  } catch {}
  if (!out) {
    try {
      const d = await itunesSearch(q);
      if (d && d.previewUrl) out = { audio: d.previewUrl,
        artwork: (d.artworkUrl100 || "").replace(/\d+x\d+/, "600x600"), source: "itunes", title: d.trackName || "" };
    } catch {}
  }
  if (!out) throw new Error("no legal audio found for: " + q);
  RES[id] = { audio: out.audio, art: out.artwork, src: out.source, title: out.title, ts: Date.now() };
  LS.set("res", RES);
  return out;
}

/* ---- GitHub private vault (music files) ---- */
function ghHeaders(raw) {
  const h = raw ? { Accept: "application/vnd.github.raw+json" }
                : { Accept: "application/vnd.github+json" };
  if (pat()) h.Authorization = "Bearer " + pat();
  return h;
}
async function vaultList() {
  const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/contents?ref=${GH.ref}`,
                        { headers: ghHeaders(false) });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new Error("vault key rejected — check it in ⚙️ settings");
    if (r.status === 404) throw new Error("vault not found (private repo needs your key)");
    throw new Error("vault error " + r.status);
  }
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error("vault is not a file list");
  return d.filter(x => x.type === "file" && /\.(mp3|m4a|flac|ogg|opus|wav)$/i.test(x.name))
    .map(x => {
      const meta = parseName(x.name);
      return { id: "local:" + x.path, name: meta.name, artists: meta.artists, album: meta.album,
               image: "", added_at: "", duration_ms: 0, uri: "", url: "", ghSize: x.size };
    });
}
function parseName(fn) {
  let base = fn.replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  base = base.replace(/\(mp3\.pm\)|\(\d+\)|\[.*?\]/g, "").trim();
  let artist = "", title = base;
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  title = title.replace(/^\d{1,2}\s*[-–]?\s*/, "").trim();
  return { name: title || base, artists: artist ? [artist] : [], album: "" };
}
const _vaultUrls = {};
async function vaultFile(path) {
  if (_vaultUrls[path]) return _vaultUrls[path];
  const cache = await caches.open("yulia-vault");
  const key = new Request(location.origin + "/__vault/" + encodeURIComponent(path));
  let hit = await cache.match(key);
  let stale = !hit;
  if (hit) {
    const t = (window._rows || []).find(t => t.id === "local:" + path);
    if (t && t.ghSize) stale = +(await hit.clone().headers.get("content-length") || 0) !== t.ghSize;
  }
  if (stale) {
    const r = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encodeURI(path)}?ref=${GH.ref}`,
                          { headers: ghHeaders(true) });
    if (!r.ok) throw new Error(r.status === 401 ? "vault key rejected" : "vault fetch failed (" + r.status + ")");
    const blob = await r.blob();
    await cache.put(key, new Response(blob, { headers: { "content-length": String(blob.size) } }));
  }
  const fresh = await (await cache.match(key)).blob();
  _vaultUrls[path] = URL.createObjectURL(fresh);
  return _vaultUrls[path];
}

let toastT;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("err", !!isErr); t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 2600);
}
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

const state = { me: null, playlists: [], track: null, playing: false, liked: false,
                progress: 0, dur: 0, context: null, view: { kind: "home" }, sdk: null, webDevice: null,
                offline: false, likedMap: {}, sortKey: "", sortDir: "asc",
                yt: null, ytReady: false, ytVideo: null, ytPlaying: false,
                queue: [], qIdx: -1 };

/* ---------- boot ---------- */
async function boot() {
  const cfg = await api("/api/config");
  if (!cfg.configured) return showSetup();
  if (!cfg.logged_in) return showGate();
  try { state.me = await api("/api/me"); } catch (e) { return showGate(e.message); }
  $("#app").classList.remove("hidden");
  state.offline = !!state.me.offline;
  $("#whoami").innerHTML = `${state.me.display_name} <span class="pill ${state.me.product === "premium" ? "premium" : ""}">${(state.me.product || "").toUpperCase()}</span>` +
    (state.offline ? ` <span class="pill sdk">OFFLINE LIBRARY</span>` : "");
  loadPlaylists();
  nav(state.offline && !state.playlists.length ? "liked" : "home");
  if (state.offline) {
    $("#devPill").textContent = "offline mode";
    $("#pTitle").textContent = `${(state.playlists.length ? "" : "")}329 liked songs ready`;
    $("#pArtists").textContent = "click any song — audio + album art, streamed for you";
    setInterval(() => {
      const au = document.getElementById("au");
      if (au && au.src && au.readyState >= 1) {
        if (au.duration) { state.dur = au.duration * 1000; $("#tDur").textContent = mmss(state.dur); }
        state.progress = (au.currentTime || 0) * 1000;
        $("#tCur").textContent = mmss(state.progress);
        $("#seekFill").style.width = (state.dur ? (100 * state.progress / state.dur) : 0) + "%";
      }
    }, 1000);
  } else {
    pollPlayer(true);
    setInterval(() => pollPlayer(false), 3000);
    if (state.me.product === "premium") initSDK();
  }
}
function showSetup() { $("#setup").classList.remove("hidden"); }
function showGate(err) {
  $("#gate").classList.remove("hidden");
  if (err && err.toLowerCase().includes("premium subscription")) {
    $("#gate .btn.big").style.display = "none";
    err += "\n\nYour login is fine — Spotify just blocks the live API on Free accounts (policy since March 2026). Import your data export when it arrives and the library loads offline.";
  }
  $("#gateErr").textContent = err ? `⚠ ${err}` :
    new URLSearchParams(location.search).get("login_error") ? `Login failed: ${new URLSearchParams(location.search).get("login_error")}` : "";
}
async function saveCfg() {
  const cid = $("#cid").value.trim();
  if (cid.length < 10) return toast("that doesn't look like a Client ID", true);
  await api("/api/config", { method: "POST", body: JSON.stringify({ client_id: cid }) });
  toast("saved — log in next");
  setTimeout(() => location.assign("/auth/login"), 700);
}

/* ---------- data ---------- */
async function loadPlaylists() {
  try {
    const d = await api("/api/playlists");
    state.playlists = d.items;
    $("#playlistNav").innerHTML = d.items.map(p =>
      `<a href="#" data-pl="${p.id}" title="${esc(p.name)}">${esc(p.name)}</a>`).join("") || `<span class="dim">none</span>`;
    document.querySelectorAll("[data-pl]").forEach(a => a.onclick = (e) => { e.preventDefault(); nav("playlist", a.dataset.pl); });
  } catch (e) { toast(e.message, true); }
}
const esc = (s) => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- views ---------- */
async function nav(kind, arg) {
  document.body.classList.remove("nav-open");
  state.view = { kind, arg };
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === kind));
  const v = $("#view");
  if (kind === "home") {
    v.innerHTML = `<h2>Home</h2><div class="sub">pick a playlist, or dive into your liked songs</div>
      <div class="grid" id="plGrid"></div>`;
    $("#plGrid").innerHTML = state.playlists.map(p =>
      `<div class="pl-card" data-pl="${p.id}"><img src="${p.image || ""}" onerror="this.style.visibility='hidden'">
       <div class="n">${esc(p.name)}</div><div class="m">${p.tracks_total} tracks · ${esc(p.owner)}</div></div>`).join("")
      || `<div class="empty">No playlists found.</div>`;
    document.querySelectorAll("#plGrid .pl-card").forEach(c => c.onclick = () => nav("playlist", c.dataset.pl));
    return;
  }
  if (kind === "files") {
    v.innerHTML = `<h2 id="vTitle">\uD83D\uDCC1 My Music</h2><div class="sub" id="vSub"></div><div id="vMore"></div>
      <div class="searchbar"><input id="q" placeholder="🔍 search title, album or artist…" autocomplete="off" spellcheck="false"></div>
      <table><thead><tr><th class="num">#</th><th></th><th>Title</th><th>Album</th><th></th><th></th></tr></thead><tbody id="rows"></tbody></table>`;
    (async () => {
      if (!pat()) {
        $("#vSub").textContent = "connect your private vault to see your files";
        $("#vMore").innerHTML = `<div class="empty">\uD83D\uDD12 This view reads music from your private GitHub vault.<br><br>
          <button class="btn" id="filesConnect">\u2699\uFE0F add vault key</button></div>`;
        $("#filesConnect").onclick = () => $("#gear").click();
        return;
      }
      try {
        const items = await vaultList();
        $("#vSub").textContent = `${items.length} files \u00B7 full length \u00B7 from your private vault`;
        state.viewBase = items; state.viewPl = null; wireSearch();
        renderRows(items, null);
        const vc = $("#vaultCount"); if (vc) vc.textContent = items.length ? `(${items.length})` : "";
      } catch (e) {
        $("#vSub").textContent = "";
        $("#vMore").innerHTML = `<div class="empty">\u26A0 ${esc(e.message)}</div>`;
      }
    })();
    return;
  }
  if (kind === "liked" || kind === "playlist") {
    const isLiked = kind === "liked";
    v.innerHTML = `<h2 id="vTitle">${isLiked ? "❤️ Liked Songs" : "…"}</h2><div class="sub" id="vSub"></div><div id="vMore"></div>
      <div class="searchbar"><input id="q" placeholder="🔍 search title, album or artist…" autocomplete="off" spellcheck="false"></div>
      <table><thead><tr><th class="num sortable" data-sort="idx">#</th><th></th><th class="sortable" data-sort="title">Title</th><th class="sortable" data-sort="album">Album</th><th class="sortable" data-sort="added">${isLiked ? "Added" : ""}</th><th></th></tr></thead><tbody id="rows"></tbody></table>`;
    wireSearch();
    let offset = 0, total = 0, items = [];
    const fetchPage = async () => {
      const d = isLiked ? await api(`/api/liked?offset=${offset}`)
                        : await api(`/api/playlists/${arg}?offset=${offset}`);
      items = items.concat(d.items); total = d.total;
      state.viewBase = items; state.viewPl = isLiked ? null : arg;
      offset = d.next_offset;
      renderRows(items, isLiked ? null : arg);
      $("#vSub").textContent = `${total} songs`;
      if (!isLiked && !$("#backBtn")) {
        const b = document.createElement("button"); b.id = "backBtn"; b.className = "mini"; b.textContent = "← back";
        b.onclick = () => nav("home"); $("#vTitle").prepend(b);
      }
      if (offset != null) {
        $("#vMore").innerHTML = `<button class="btn" style="margin:14px 0">Load more</button>`;
        $("#vMore button").onclick = () => { $("#vMore").innerHTML = ""; fetchPage().catch(e => toast(e.message, true)); };
      } else $("#vMore").innerHTML = "";
    };
    if (!isLiked) {
      const p = state.playlists.find(p => p.id === arg);
      if (p) $("#vTitle").textContent = p.name;
    }
    fetchPage().catch(e => { v.innerHTML += `<div class="empty">⚠ ${esc(e.message)}</div>`; });
  }
}
function renderRows(items, playlistId) {
  $("#rows").innerHTML = items.map((t, i) => `
    <tr class="rowplay ${state.track && state.track.id === t.id ? "playing" : ""}" data-i="${i}">
      <td class="num">${i + 1}</td>
      <td><img class="cov" src="${t.image || ""}" onerror="this.style.visibility='hidden'"></td>
      <td><div>${esc(t.name)}</div><div class="al">${esc((t.artists || []).join(", "))}</div></td>
      <td class="al">${esc(t.album)}</td>
      <td class="al">${t.added_at || ""}</td>
      <td class="rowbtns">
        <button data-act="like" data-id="${t.id}" title="Like / unlike">${state.likedMap[t.id] ? "\u2764\uFE0F" : "\u{1F90D}"}</button>
        <button data-act="dislike" data-id="${t.id}" title="Dislike (also unlikes)">\u{1F44E}</button>
      </td>
    </tr>`).join("");
  window._rows = items;
  document.querySelectorAll("#rows tr").forEach(tr => tr.onclick = () => {
    const t = window._rows[+tr.dataset.i];
    if (state.offline) {
      state.queue = items;
      resolveAndPlay(+tr.dataset.i);
      return;
    }
    playTrack(t, playlistId, items);
  });
  document.querySelectorAll("#rows [data-act]").forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.dataset.id;
    try {
      if (b.dataset.act === "like") {
        const now = !state.likedMap[id];
        await api("/api/like/" + id, { method: now ? "PUT" : "DELETE" });
        state.likedMap[id] = now;
        toast(now ? "Liked \u2764\uFE0F" : "Removed from Liked");
      } else {
        await api("/api/dislike/" + id, { method: "POST" });
        state.likedMap[id] = false;
        toast("Disliked \u{1F44E}");
      }
      renderRows(window._rows, playlistId);
    } catch (err) { toast(err.message, true); }
  });
  document.querySelectorAll("th.sortable").forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    state.sortDir = (state.sortKey === k && state.sortDir !== "desc") ? "desc" : "asc";
    state.sortKey = k;
    const val = (t) => k === "title" ? t.name.toLowerCase()
      : k === "album" ? (t.album || "").toLowerCase()
      : k === "added" ? (t.added_at || "")
      : items.indexOf(t);
    const sorted = [...items].sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * (state.sortDir === "asc" ? 1 : -1);
    });
    renderRows(sorted, playlistId);
  });
  paintRowHearts(items);
}
async function paintRowHearts(items) {
  const ids = items.slice(0, 50).map(t => t.id).filter(Boolean);
  if (!ids.length) return;
  try {
    const d = await api(`/api/liked/contains?ids=${ids.join(",")}`);
    Object.assign(state.likedMap, d.results || {});
    document.querySelectorAll("#rows tr").forEach((tr, i) => {
      const t = window._rows[i]; if (!t) return;
      const btn = tr.querySelector('[data-act="like"]');
      if (btn) btn.textContent = state.likedMap[t.id] ? "\u2764\uFE0F" : "\u{1F90D}";
    });
  } catch {}
}

/* ---------- playback ---------- */
async function playTrack(t, playlistId, list) {
  try {
    if (playlistId) await api("/api/player/play", { method: "POST", body: JSON.stringify(
      { context_uri: "spotify:playlist:" + playlistId, offset_id: t.id }) });
    else await api("/api/player/play", { method: "POST", body: JSON.stringify(
      { uris: list.map(x => x.uri) }) });
    state.track = t; paintPlayer(); pollPlayer(true);
  } catch (e) { toast(e.message, true); }
}
async function pollPlayer(force) {
  let p;
  try { p = await api("/api/player"); } catch (e) { if (force) toast(e.message, true); return; }
  const prevId = state.track && state.track.id;
  state.playing = p.is_playing;
  state.context = p.context;
  if (p.track) {
    state.track = p.track;
    state.dur = p.track.duration_ms || 0;
    state.progress = p.progress_ms || 0;
    if (prevId !== p.track.id) checkLiked(p.track.id);
  } else { state.track = null; state.liked = false; }
  const dev = p.device;
  const dp = $("#devPill");
  dp.textContent = dev ? `📺 ${dev.name}` : "no device";
  dp.classList.toggle("ok", !!dev);
  if (dev) { $("#vol").value = dev.volume ?? 50; }
  paintPlayer();
}
async function checkLiked(id) {
  try {
    const d = await api(`/api/liked/contains?ids=${id}`);
    state.liked = !!d.results[id];
  } catch { state.liked = false; }
  paintLike();
}
function paintPlayer() {
  const t = state.track;
  $("#btnPlay").disabled = !state.track;
  $("#btnPlay").textContent = state.playing ? "⏸" : "▶";
  if (!t) return;
  $("#pImg").src = t.image || ""; $("#pImg").classList.toggle("hidden", !t.image);
  $("#pTitle").textContent = t.name;
  $("#pArtists").textContent = (t.artists || []).join(", ");
  $("#tDur").textContent = mmss(state.dur);
  $("#btnLike").disabled = $("#btnDislike").disabled = false;
  paintLike();
  if (!state.scrubbing) {
    $("#tCur").textContent = mmss(state.progress);
    $("#seekFill").style.width = state.dur ? (100 * state.progress / state.dur) + "%" : "0%";
  }
}
function paintLike() {
  const b = $("#btnLike");
  b.textContent = state.liked ? "❤️" : "🤍";
  b.classList.toggle("on", state.liked);
}
async function ctrl(action, body) {
  try { return await api("/api/player/" + action, { method: "POST", body: JSON.stringify(body || {}) }); }
  catch (e) { toast(e.message, true); throw e; }
}

$("#btnPlay").onclick = () => { if (state.offline) return audioToggle();
  ctrl(state.playing ? "pause" : "play").then(() => pollPlayer(true)).catch(() => {}); };
$("#btnNext").onclick = () => { if (state.offline) return walkQueue(1);
  ctrl("next").then(() => setTimeout(() => pollPlayer(true), 600)).catch(() => {}); };
$("#btnPrev").onclick = () => { if (state.offline) return walkQueue(-1);
  ctrl("previous").then(() => setTimeout(() => pollPlayer(true), 600)).catch(() => {}); };
$("#btnShuffle").onclick = async () => {
  if (state.offline) return;
  const on = !$("#btnShuffle").classList.contains("on");
  try { await ctrl("shuffle", { state: on }); $("#btnShuffle").classList.toggle("on", on); } catch {}
};
$("#vol").onchange = (e) => { if (state.offline) return;
  ctrl("volume", { volume: +e.target.value }).catch(() => {}); };
$("#seekbar").onclick = async (e) => {
  if (state.offline) {
    const au = document.getElementById("au");
    if (au && au.src && state.dur) {
      const r = e.currentTarget.getBoundingClientRect();
      au.currentTime = ((e.clientX - r.left) / r.width) * state.dur / 1000;
    }
    return;
  }
  if (!state.dur) return;
  const r = e.currentTarget.getBoundingClientRect();
  const ms = Math.round((e.clientX - r.left) / r.width * state.dur);
  try { await ctrl("seek", { position_ms: ms }); state.progress = ms; paintPlayer(); } catch {}
};

$("#btnLike").onclick = async () => {
  if (!state.track) return;
  try {
    if (state.liked) { await api("/api/like/" + state.track.id, { method: "DELETE" }); toast("Removed from Liked"); }
    else { await api("/api/like/" + state.track.id, { method: "PUT" }); toast("Added to Liked ❤️"); }
    state.liked = !state.liked; paintLike();
  } catch (e) { toast(e.message, true); }
};
$("#btnDislike").onclick = async () => {
  if (!state.track) return;
  try {
    const d = await api("/api/dislike/" + state.track.id, { method: "POST" });
    state.liked = false; paintLike();
    toast(d.logged_to_disliked ? "Disliked — logged & skipping 👎" : "Disliked — skipping 👎");
    await ctrl("next");
    setTimeout(() => pollPlayer(true), 700);
  } catch (e) { toast(e.message, true); }
};

/* progress ticker while playing (API poll is every 3s; smooth it locally) */
setInterval(() => {
  if (state.playing && !state.scrubbing && state.track) {
    state.progress = Math.min(state.dur, state.progress + 1000);
    $("#tCur").textContent = mmss(state.progress);
    $("#seekFill").style.width = (100 * state.progress / state.dur) + "%";
  }
}, 1000);

/* ---------- Web Playback SDK (Premium: browser becomes the device) ---------- */
function initSDK() {
  if (!window.Spotify) { setTimeout(initSDK, 800); return; }
  try {
    const player = new Spotify.Player({
      name: "Hermes Tunes Web",
      getOAuthToken: async (cb) => { const d = await api("/api/token"); cb(d.token); },
      volume: 0.6,
    });
    ["ready", "not_ready", "player_state_changed"].forEach(() => {});
    player.on("ready", async ({ device_id }) => {
      state.webDevice = device_id; state.sdk = player;
      $("#sdkPill").classList.remove("hidden");
      await api("/api/player/web-device", { method: "POST", body: JSON.stringify({ device_id }) });
      toast("Web player ready — browser is now a device 🎧");
      pollPlayer(true);
    });
    player.on("player_state_changed", () => pollPlayer(true));
    player.on("initialization_error", () => console.log("SDK init error"));
    player.on("authentication_error", () => console.log("SDK auth error"));
    player.on("account_error", () => console.log("SDK account error (Free account?)"));
    player.connect();
  } catch (e) { console.log("SDK unavailable:", e); }
}

/* ---------- audio streaming (offline mode media source) ---------- */
async function resolveAndPlay(idx) {
  const t = state.queue[idx];
  if (!t) return;
  state.qIdx = idx;
  try {
    const d = await api("/api/music-resolve", { method: "POST",
      body: JSON.stringify({ id: t.id, q: t.name + " " + (t.artists || []).join(" ") }) });
    state.track = t;
    state.audioSource = d.source;
    state.dur = t.duration_ms || state.dur;
    if (d.artwork) {
      t.image = d.artwork;
      const rowImg = document.querySelector(`#rows tr[data-i="${idx}"] img.cov`);
      if (rowImg && !rowImg.src) rowImg.src = d.artwork;
    }
    const au = document.getElementById("au");
    au.src = d.audio;
    au.play().catch(() => toast("Tap ▶ to start audio (browser blocked autoplay)", true));
    paintPlayer();
    $("#pArtists").textContent = (t.artists || []).join(", ") +
      "  ·  " + (d.label || d.source + " preview");
    toast("\u25B6 " + (d.title || t.name));
  } catch (e) { toast(e.message, true); }
}
function audioToggle() {
  const au = document.getElementById("au");
  if (!au || !au.src) {
    if (state.queue.length) return resolveAndPlay(state.qIdx >= 0 ? state.qIdx : 0);
    return toast("Click a song to start listening", true);
  }
  au.paused ? au.play() : au.pause();
}
function walkQueue(step) {
  if (!state.queue.length) return toast("Open a list and click a song first", true);
  let i = state.qIdx + step;
  if (i < 0) i = state.queue.length - 1;
  if (i >= state.queue.length) i = 0;
  resolveAndPlay(i);
}
(function wireAudio() {
  const au = document.getElementById("au");
  if (!au) return;
  au.addEventListener("play", () => { state.playing = true; $("#btnPlay").textContent = "\u23F8"; });
  au.addEventListener("pause", () => { state.playing = false; $("#btnPlay").textContent = "\u25B6"; });
  au.addEventListener("ended", () => walkQueue(1));
  au.addEventListener("error", () => {
    if (au.src) { toast("Couldn\u2019t play that one \u2014 skipping", true); walkQueue(1); }
  });
})();

/* ---------- search (title / album / artist) ---------- */
function wireSearch() {
  const qi = document.getElementById("q");
  if (!qi) return;
  if (!state.fullLiked) loadLib().then(lib => { state.fullLiked = (lib && lib.liked) || []; }).catch(() => {});
  qi.oninput = () => {
    const qq = qi.value.toLowerCase().trim();
    const base = state.viewBase || [];
    const likedView = state.view && state.view.kind === "liked";
    let pool = likedView && state.fullLiked && state.fullLiked.length ? state.fullLiked : base;
    pool = pool.filter(t => (OVER[t.id] ?? 0) !== -1);
    const f = !qq ? base : pool.filter(t =>
      ((t.name || "") + " " + (t.album || "") + " " + (t.artists || []).join(" ")).toLowerCase().includes(qq));
    renderRows(f, state.viewPl || null);
    const sub = document.getElementById("vSub");
    if (sub) sub.textContent = qq ? `${f.length} of ${pool.length} matches` : `${base.length} songs`;
  };
}

/* ---------- burger / drawer / splash ---------- */
$("#burger").onclick = () => document.body.classList.toggle("nav-open");
const _scrim = document.querySelector(".navscrim");
if (_scrim) _scrim.onclick = () => document.body.classList.remove("nav-open");

/* ---------- settings (vault key) ---------- */
$("#gear").onclick = () => {
  $("#patIn").value = pat();
  $("#patStatus").textContent = pat() ? "key: saved in this browser \u2713" : "no key yet";
  $("#settings").classList.remove("hidden");
};
$("#patClose").onclick = () => $("#settings").classList.add("hidden");
$("#patClear").onclick = () => { LS.set("pat", ""); $("#patIn").value = "";
  $("#patStatus").textContent = "key forgotten"; toast("vault key forgotten"); };
$("#patSave").onclick = async () => {
  const v = $("#patIn").value.trim();
  if (!v) return toast("paste a token first", true);
  LS.set("pat", v);
  try {
    const files = await vaultList();
    $("#patStatus").textContent = `connected \u2713 ${files.length} files in your vault`;
    toast(`vault connected \u2713 ${files.length} files`);
    const vc = $("#vaultCount"); if (vc) vc.textContent = `(${files.length})`;
    setTimeout(() => $("#settings").classList.add("hidden"), 900);
  } catch (e) {
    LS.set("pat", "");
    $("#patStatus").textContent = "\u2717 " + e.message;
    toast(e.message, true);
  }
};

document.querySelectorAll("[data-nav]").forEach(a => a.onclick = (e) => { e.preventDefault(); nav(a.dataset.nav); });
boot().catch(e => toast(e.message, true)).finally(() => {
  const sp = document.getElementById("splash");
  if (sp) setTimeout(() => sp.classList.add("hidden"), 650);
});