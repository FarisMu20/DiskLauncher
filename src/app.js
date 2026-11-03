const { invoke } = window.__TAURI__.core;
const $ = (s) => document.querySelector(s);
const rail = $('#rail'), track = $('#track'), meta = $('#meta'), nameEl = $('#name'), subEl = $('#sub'), menu = $('#menu');
const dockBtns = [...document.querySelectorAll('.dock .round')];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let games = [];
let sel = 0;            // selected game
let zone = 'rail';      // 'rail' = game row, 'dock' = round buttons
let dockIdx = 0;
let busy = false, fs = false, overlayOpen = false;
let playing = null;     // { id, start, timer } while a game is running
let muted = localStorage.getItem('muted') === '1';

// sort + layout (remembered between launches)
const SORTS = [['none', 'Added order'], ['name', 'Name A–Z'], ['time', 'Most played'], ['random', 'Random']];
const LAYOUTS = [['carousel', 'Carousel'], ['grid', 'Grid'], ['list', 'List']];
const LAYOUT_ICONS = {
  carousel: '<svg viewBox="0 0 24 24"><circle cx="4.6" cy="12" r="2.6" fill="currentColor" opacity=".55"/><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="19.4" cy="12" r="2.6" fill="currentColor" opacity=".55"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="3.2" fill="currentColor"/><circle cx="17" cy="7" r="3.2" fill="currentColor"/><circle cx="7" cy="17" r="3.2" fill="currentColor"/><circle cx="17" cy="17" r="3.2" fill="currentColor"/></svg>',
  list: '<svg viewBox="0 0 24 24"><circle cx="5" cy="7" r="1.9" fill="currentColor"/><circle cx="5" cy="12" r="1.9" fill="currentColor"/><circle cx="5" cy="17" r="1.9" fill="currentColor"/><path d="M10 7h10M10 12h10M10 17h10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
};
let sortMode = localStorage.getItem('sort'); if (!SORTS.some((s) => s[0] === sortMode)) sortMode = 'none';
let layout = localStorage.getItem('layout'); if (!LAYOUTS.some((s) => s[0] === layout)) layout = 'carousel';
let raw = [];            // games in the order the backend gave them (used by "Added order")
const rank = new Map();  // random order, stays the same until you pick Random again

/* ================= sound (generated in code, no files) ================= */
let ac = null;
function ctx() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (ac && ac.state === 'suspended') ac.resume();
  return ac;
}
['pointerdown', 'keydown'].forEach((ev) => addEventListener(ev, ctx, { once: true, capture: true }));

function tone({ f = 800, to = null, dur = .12, type = 'sine', vol = .1, at = 0 }) {
  if (muted) return; const a = ctx(); if (!a) return;
  const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + .004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + .03);
}
function swoosh({ dur = .6, from = 300, to = 3200, vol = .06, at = 0 } = {}) {
  if (muted) return; const a = ctx(); if (!a) return;
  const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
  const t = a.currentTime + at;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * .45); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(a.destination); s.start(t);
}
const sfx = {
  move:   () => tone({ f: 1500, to: 1150, dur: .05, type: 'triangle', vol: .08 }),
  edge:   () => tone({ f: 300, to: 240, dur: .09, vol: .09 }),
  open:   () => { tone({ f: 700, to: 1000, dur: .1, vol: .09 }); },
  back:   () => tone({ f: 900, to: 600, dur: .09, vol: .08 }),
  toggle: () => tone({ f: 1250, dur: .07, type: 'triangle', vol: .08 }),
  add:    () => [659, 880, 1175].forEach((f, i) => tone({ f, dur: .3, vol: .08, at: i * .08 })),
  remove: () => tone({ f: 520, to: 260, dur: .22, type: 'triangle', vol: .09 }),
  welcome:() => [880, 659, 784, 1046].forEach((f, i) => tone({ f, dur: .35, vol: .08, at: i * .1 })),
  error:  () => { tone({ f: 220, dur: .12, type: 'square', vol: .04 }); tone({ f: 196, dur: .18, type: 'square', vol: .04, at: .13 }); },
  // a disc sliding into the console: whoosh, a soft clack, a tiny metal ting
  slide:  () => {
    swoosh({ dur: .3, from: 2600, to: 500, vol: .05 });
    tone({ f: 170, to: 80, dur: .09, type: 'triangle', vol: .13, at: .27 });
    tone({ f: 2300, dur: .2, vol: .025, at: .28 });
  },
  boop:   () => tone({ f: 660, to: 990, dur: .12, type: 'triangle', vol: .08 }),
  milestone: () => [988, 1319, 1568].forEach((f, i) => tone({ f, dur: .4, vol: .08, at: i * .09 })),
  launch: () => {
    sfx.slide();
    tone({ f: 523, dur: .35, vol: .09, at: .38 }); tone({ f: 784, dur: .45, vol: .09, at: .47 }); tone({ f: 1046, dur: .65, vol: .07, at: .56 });
  },
};


/* ================= "now playing" tune (soft music box, generated in code) ================= */
const music = (() => {
  const chords = [[48, 55, 59, 64], [45, 52, 57, 60], [41, 48, 52, 57], [43, 50, 55, 62]]; // C, Am, F, G
  const pattern = [0, 1, 2, 3, 2, 1, 3, 2];
  const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
  let master = null, bus = null, timer = null, nextT = 0, step = 0, on = false;

  function build(a) {
    master = a.createGain(); master.gain.value = 0; master.connect(a.destination);
    bus = a.createGain(); bus.connect(master);
    const dly = a.createDelay(); dly.delayTime.value = .33;
    const fb = a.createGain(); fb.gain.value = .38;
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    bus.connect(dly); dly.connect(lp); lp.connect(fb); fb.connect(dly); lp.connect(master);
  }
  function voice(a, f, t, vol, dur, type) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + .01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus); o.start(t); o.stop(t + dur + .05);
  }
  function playStep(a, t) {
    const chord = chords[Math.floor(step / 8) % chords.length], i = step % 8;
    voice(a, mtof(chord[pattern[i]] + 12), t, .07, 1.7, 'triangle');
    if (i % 4 === 0) voice(a, mtof(chord[i === 0 ? 0 : 1] - 12), t, .06, 2.2, 'sine');
    step++;
  }
  function schedule() { const a = ac; while (nextT < a.currentTime + .6) { playStep(a, nextT); nextT += .55; } }
  function level() { return !muted && on && document.hasFocus() ? .9 : 0; }
  function apply(tc) { if (master) master.gain.setTargetAtTime(level(), ac.currentTime, tc); }
  return {
    start() {
      const a = ctx(); if (!a || on) return;
      if (!master) build(a);
      on = true; step = 0; nextT = a.currentTime + .05;
      timer = setInterval(schedule, 120); apply(.8);
    },
    stop() { on = false; clearInterval(timer); apply(.4); },
    sync() { apply(.5); },   // call when focus or mute changes
  };
})();
addEventListener('blur', () => music.sync());
addEventListener('focus', () => music.sync());

/* ================= disc images: fallback store (used when the Rust side is older) ================= */
const lsCovers = () => { try { return JSON.parse(localStorage.getItem('covers') || '{}'); } catch (e) { return {}; } };
const putCovers = (c) => localStorage.setItem('covers', JSON.stringify(c));
const mergeCovers = (list) => { const c = lsCovers(); raw = list.map((g) => (g.cover ? g : { ...g, cover: c[g.id] || '' })); return sortList(raw); };
function sortList(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const l = [...list];
  if (sortMode === 'name') l.sort(byName);
  else if (sortMode === 'time') l.sort((a, b) => (b.total_secs || 0) - (a.total_secs || 0) || byName(a, b));
  else if (sortMode === 'random') { l.forEach((g) => { if (!rank.has(g.id)) rank.set(g.id, Math.random()); }); l.sort((a, b) => rank.get(a.id) - rank.get(b.id)); }
  return l;
}
const noCmd = (e) => /not found/i.test(String(e));

/* ================= helpers ================= */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3600);
}
const call = async (cmd, args) => {
  try { return await invoke(cmd, args); }
  catch (e) { toast(String(e)); sfx.error(); return null; }
};
function ago(ts) {
  if (!ts) return 'Never played';
  const s = Date.now() / 1000 - ts;
  if (s < 90) return 'Played just now';
  if (s < 3600) return `Played ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `Played ${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'Played yesterday' : `Played ${d} days ago`;
}

const dayNum = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);   // local day number
function dur(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
function longDur(secs) {
  const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60);
  if (h >= 10) return `${h} hours`;
  if (h >= 1) return `${h} hour${h > 1 ? 's' : ''}${m ? ` ${m} min` : ''}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}
function tierOf(secs) {
  const h = (secs || 0) / 3600;
  if (h >= 100) return { n: 100, cls: 'gold', txt: '100h' };
  if (h >= 50) return { n: 50, cls: 'silver', txt: '50h' };
  if (h >= 10) return { n: 10, cls: 'bronze', txt: '10h' };
  return null;
}

/* ================= rendering ================= */
function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
function makeDisc(cover) {
  const d = el('div', 'disc' + (cover ? ' has-img' : ''));
  d.innerHTML = '<div class="plate"><div class="spin"><div class="face"></div><div class="label"></div></div><div class="glint"></div></div>';
  if (cover) d.querySelector('.label').style.backgroundImage = `url("${cover}")`;
  return d;
}
function withRing(inner) { const b = el('div', 'bob'); b.append(el('div', 'ring'), inner); return b; }
function render() {
  track.innerHTML = '';
  games.forEach((g, i) => {
    const t = el('button', 'tile'); t.setAttribute('aria-label', g.name);
    t.style.setProperty('--d', `${-(i * .55)}s`); t.style.setProperty('--i', Math.min(i, 24));
    const bob = withRing(makeDisc(g.cover));
    const tier = tierOf(g.total_secs);
    if (tier) { const s = el('div', 'sticker ' + tier.cls); s.textContent = tier.txt; bob.append(s); }
    t.append(el('div', 'shade'), bob);
    const info = el('div', 'tinfo'), nm = el('b', ''), sb = el('span', '');
    nm.textContent = g.name; sb.textContent = subOf(g); info.append(nm, sb); t.append(info);   // only visible in List layout
    t._sp = t.querySelector('.spin');
    t.onmouseenter = () => { t._hover = true; };
    t.onmouseleave = () => { t._hover = false; };
    // click = move the cursor there, then start (like tapping an icon on the Switch)
    t.onclick = () => { const was = sel; focusGame(i); if (was === i) launch(i); else setTimeout(() => launch(i), 260); };
    t.oncontextmenu = (e) => { e.preventDefault(); focusGame(i); openMenu(e.clientX, e.clientY); };
    track.append(t);
  });
  sel = Math.max(0, Math.min(sel, games.length - 1));
  $('#empty').hidden = games.length > 0; rail.classList.toggle('none', !games.length);
  if (!games.length) { zone = 'dock'; dockIdx = 0; }   // empty: point the cursor at the + button
  update(true);
}
function subOf(g) { const t = g.total_secs || 0; return ago(g.last_played) + (t >= 60 ? ` · ${dur(t)} total` : ''); }
function labels() {
  if (zone === 'dock') { const b = dockBtns[dockIdx]; return [b.dataset.label, b.dataset.sub || '']; }
  const g = games[sel];
  if (g) return [g.name, subOf(g)];
  return ['No games yet', 'Press the + button below to add your first game'];
}
function update(instant) {
  const tiles = [...track.children];
  tiles.forEach((t, i) => t.classList.toggle('sel', i === sel && zone === 'rail'));
  dockBtns.forEach((b, i) => b.classList.toggle('cur', zone === 'dock' && i === dockIdx));

  const t = tiles[sel];
  if (t && layout === 'carousel') {
    rail.scrollTop = 0;
    const x = rail.clientWidth / 2 - (t.offsetLeft + t.offsetWidth / 2);
    if (instant) track.style.transition = 'none';
    track.style.transform = `translateX(${x}px)`;
    if (instant) { track.offsetWidth; track.style.transition = ''; }
  } else if (t) {   // grid / list: the rail scrolls vertically
    track.style.transform = '';
    rail.scrollTo({ top: track.offsetTop + t.offsetTop - rail.clientHeight / 2 + t.offsetHeight / 2, behavior: instant ? 'auto' : 'smooth' });
  }

  const [title, sub] = labels();
  const apply = () => { nameEl.textContent = title; subEl.textContent = sub; meta.classList.remove('swap'); };
  if (instant) apply();
  else if (nameEl.textContent !== title || subEl.textContent !== sub) {
    meta.classList.add('swap'); clearTimeout(update.t); update.t = setTimeout(apply, 140);
  }
}

/* ================= navigation ================= */
function select(i) {
  const n = Math.max(0, Math.min(games.length - 1, i));
  if (n === sel) return sfx.edge();
  sel = n; sfx.move(); update(false);
}
function focusGame(i) {
  const changed = i !== sel || zone !== 'rail';
  zone = 'rail'; sel = i;
  if (changed) sfx.move();
  update(false);
}
function nav(dir) {
  if (zone === 'rail') return select(sel + dir);
  const n = Math.max(0, Math.min(dockBtns.length - 1, dockIdx + dir));
  if (n === dockIdx) return sfx.edge();
  dockIdx = n; sfx.move(); update(false);
}
function gridCols() {
  const t = [...track.children]; if (t.length < 2) return 1;
  let n = 0; while (n < t.length && t[n].offsetTop === t[0].offsetTop) n++;
  return n;
}
function vert(dir) {
  hoverDock = false;
  if (zone === 'rail' && games.length && layout !== 'carousel') {
    const last = games.length - 1;
    if (layout === 'list') {
      if (dir < 0 && sel > 0) return select(sel - 1);
      if (dir > 0 && sel < last) return select(sel + 1);
    } else {
      const c = gridCols();
      if (dir < 0 && sel - c >= 0) return select(sel - c);
      if (dir > 0 && sel + c <= last) return select(sel + c);
      if (dir > 0 && Math.floor(sel / c) < Math.floor(last / c)) return select(last);   // short last row
    }
  }
  if (dir > 0 && zone === 'rail') { zone = 'dock'; sfx.move(); update(false); }
  else if (dir < 0 && zone === 'dock' && games.length) { zone = 'rail'; sfx.move(); update(false); }
}
function enter() {
  if (zone === 'dock') return dockBtns[dockIdx].click();
  launch(sel);
}
function back() { if (zone === 'dock' && games.length) { zone = 'rail'; sfx.back(); update(false); } }

/* ================= actions ================= */
async function addGames() {
  if (busy) return;
  busy = true;
  const before = games.length;
  const list = await call('add_games');
  busy = false;
  if (!list) return;
  games = mergeCovers(list); zone = 'rail'; sel = list.length > before ? 0 : Math.min(sel, Math.max(0, list.length - 1)); render();
  if (list.length > before) { sfx.add(); toast(`Added ${list.length - before} game${list.length - before > 1 ? 's' : ''}`); }
}
function fmt(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
function closeOverlay() {
  const r = $('#launch');
  r.classList.add('out');
  setTimeout(() => { r.hidden = true; r.classList.remove('playing'); $('#launchSub').textContent = ''; overlayOpen = false; busy = false; update(true); }, 560);
}
function startPlaying(g) {
  playing = { id: g.id, start: Date.now(), timer: null };
  $('#launch').classList.add('playing');
  const tickPlay = () => { $('#launchSub').textContent = `Now playing · ${fmt(Date.now() - playing.start)}`; };
  tickPlay(); playing.timer = setInterval(tickPlay, 1000);
  music.start();
  poke();   // the mascot dozes off if nothing happens here for a while
}
function endPlaying(reason) {
  if (!playing) return;
  clearInterval(playing.timer); playing = null;
  clearTimeout(lmT); clearTimeout(lmSleepT);
  music.stop();
  cheer(2600);
  if (reason === 'exit') sfx.welcome(); else sfx.back();
  closeOverlay();
}
async function launch(idx) {
  const g = games[idx];
  if (!g || busy) return;
  busy = true; overlayOpen = true;

  const tr = track.children[idx].querySelector('.disc').getBoundingClientRect();
  const r = $('#launch');
  r.style.setProperty('--dx', `${tr.left + tr.width / 2 - innerWidth / 2}px`);
  r.style.setProperty('--dy', `${tr.top + tr.height / 2 - innerHeight / 2}px`);
  r.style.setProperty('--s0', tr.width / 200);
  $('#lcard').replaceChildren(makeDisc(g.cover));
  $('#launchName').textContent = g.name;
  r.hidden = false; r.classList.remove('open', 'out', 'playing'); void r.offsetWidth; r.classList.add('open');
  sfx.launch();
  lm.dataset.dir = 'r'; mset(lm, 'happy'); clearTimeout(lmT); lmT = setTimeout(() => { lm.dataset.s = 'awake'; }, 2400);

  let ok = false, tracked = false;
  const run = invoke('launch_game', { id: g.id, day: dayNum() })
    .then((t) => { ok = true; tracked = !!t; })
    .catch((e) => { toast(String(e)); sfx.error(); });
  await Promise.all([run, sleep(1400)]);
  if (ok) {
    g.last_played = Math.floor(Date.now() / 1000);
    const d = dayNum(); g.play_days = g.play_days || [];
    if (!g.play_days.includes(d)) g.play_days.push(d);
  }

  if (ok && tracked) startPlaying(g);   // stay on this screen until the game closes
  else closeOverlay();
}
async function removeSel() {
  const g = games[sel]; if (!g) return;
  const tile = track.children[sel];
  if (tile && tile.classList.contains('removing')) return;
  if (tile) tile.classList.add('removing');   // disc spins away + shrinks, then the list updates
  sfx.remove();
  const [list] = await Promise.all([call('remove_game', { id: g.id }), sleep(480)]);
  if (!list) { if (tile) tile.classList.remove('removing'); return; }
  { const c = lsCovers(); delete c[g.id]; putCovers(c); }
  games = mergeCovers(list); render(); toast(`Removed ${g.name}`);
}
function openRename() {
  const g = games[sel]; if (!g) return;
  $('#modal').hidden = false; sfx.open();
  const i = $('#renameInput'); i.value = g.name; i.focus(); i.select();
}
function closeRename() { $('#modal').hidden = true; sfx.back(); }

/* ================= menu / modal ================= */
function openMenu(x, y) {
  if (!games[sel]) return;
  if (x === undefined) { const r = track.children[sel].getBoundingClientRect(); x = r.right; y = r.top + 20; }
  $('#mUncover').hidden = !games[sel].cover;
  menu.hidden = false; sfx.open();
  menu.style.left = Math.min(x, innerWidth - 250) + 'px';
  menu.style.top = Math.min(y, innerHeight - 260) + 'px';
  $('#mRename').focus();
}
function closeMenu(silent) { menu.hidden = true; if (!silent) sfx.back(); }
$('#mRename').onclick = () => { closeMenu(true); openRename(); };
$('#mRemove').onclick = () => { closeMenu(true); removeSel(); };
$('#mCover').onclick = () => { closeMenu(true); $('#coverFile').click(); };
$('#mUncover').onclick = async () => {
  closeMenu(true);
  const g = games[sel]; if (!g) return;
  const disc = track.children[sel] && track.children[sel].querySelector('.disc');
  if (disc) disc.classList.add('peeling'); sfx.remove();   // the printed label peels off
  const wait = sleep(520);
  let list;
  try { list = await invoke('remove_cover', { id: g.id }); }
  catch (e) { if (!noCmd(e)) { if (disc) disc.classList.remove('peeling'); toast(String(e)); return; } list = games.map((x) => (x.id === g.id ? { ...x, cover: '' } : x)); }
  const c = lsCovers(); delete c[g.id]; putCovers(c);
  list = list.map((x) => (x.id === g.id ? { ...x, cover: '' } : x));
  await wait;
  games = mergeCovers(list); render();
};
// pick an image -> square-crop to 640px WebP -> store it
$('#coverFile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  const g = games[sel]; if (!file || !g) return;
  try {
    const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    const S = 640, c = document.createElement('canvas'); c.width = c.height = S;
    const m = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
    const data = c.toDataURL('image/webp', .92);
    let list;
    try { list = await invoke('save_cover', { id: g.id, data }); }
    catch (e) {
      if (!noCmd(e)) throw e;
      try { const st = lsCovers(); st[g.id] = data; putCovers(st); } catch (q) { throw new Error('quota'); }
      list = games.map((x) => (x.id === g.id ? { ...x, cover: data } : x));
    }
    if (list) { games = mergeCovers(list); sel = Math.max(0, games.findIndex((x) => x.id === g.id)); render(); sfx.add(); toast('Disc image set'); }
  } catch (err) { toast(err && err.message === 'quota' ? 'Too many disc images stored. Remove one first.' : 'Could not read that image'); sfx.error(); }
};
document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
$('#renameCancel').onclick = closeRename;
$('#renameForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#renameInput').value.trim(); const g = games[sel];
  $('#modal').hidden = true; if (!name || !g) return;
  const list = await call('rename_game', { id: g.id, name });
  if (list) { games = mergeCovers(list); sel = Math.max(0, games.findIndex((x) => x.id === g.id)); render(); sfx.toggle(); }
};

/* ================= round buttons, theme, sound, clock ================= */
const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor"/></svg>';
const SPK = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>';
const SPK_ON = `<svg viewBox="0 0 24 24">${SPK}<path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const SPK_OFF = `<svg viewBox="0 0 24 24">${SPK}<path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

function setTheme(t) {
  document.documentElement.dataset.theme = t; localStorage.setItem('theme', t);
  $('#btnTheme').innerHTML = t === 'dark' ? SUN : MOON;
}
function setMuted(m) {
  muted = m; localStorage.setItem('muted', m ? '1' : '0');
  $('#btnSound').innerHTML = m ? SPK_OFF : SPK_ON;
  $('#btnSound').dataset.sub = m ? 'Off' : 'On';
  music.sync();
}
async function toggleFullscreen() {
  fs = !fs;
  try { await window.__TAURI__.window.getCurrentWindow().setFullscreen(fs); } catch (e) { fs = !fs; }
}
$('#btnAdd').onclick = addGames;
$('#btnStats').onclick = openStats;
$('#btnScan').onclick = openScan;
function pop() { track.classList.remove('fresh'); void track.offsetWidth; track.classList.add('fresh'); clearTimeout(pop.t); pop.t = setTimeout(() => track.classList.remove('fresh'), 1000); }
function setSort(m, animate = true) {
  sortMode = m; localStorage.setItem('sort', m);
  $('#btnSort').dataset.sub = SORTS.find((s) => s[0] === m)[1];
  if (!animate) return;
  const keep = games[sel] && games[sel].id;
  if (m === 'random') rank.clear();
  games = sortList(raw);
  sel = Math.max(0, games.findIndex((g) => g.id === keep));
  render(); pop();
}
function setLayout(l, animate = true) {
  layout = l; localStorage.setItem('layout', l);
  rail.dataset.layout = l;
  $('#btnLayout').innerHTML = LAYOUT_ICONS[l];
  $('#btnLayout').dataset.sub = LAYOUTS.find((s) => s[0] === l)[1];
  if (!animate) return;
  render(); pop();
}
const nextOf = (list, cur) => list[(list.findIndex((s) => s[0] === cur) + 1) % list.length][0];
$('#btnSort').onclick = () => { setSort(nextOf(SORTS, sortMode)); sfx.toggle(); update(false); toast(`Sort: ${$('#btnSort').dataset.sub}`); };
$('#btnLayout').onclick = () => { setLayout(nextOf(LAYOUTS, layout)); sfx.toggle(); update(false); toast(`Layout: ${$('#btnLayout').dataset.sub}`); };
$('#btnTheme').onclick = () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); sfx.toggle(); update(false); };
$('#btnSound').onclick = () => { setMuted(!muted); sfx.toggle(); update(false); };
$('#btnFull').onclick = toggleFullscreen;
$('#launchBack').onclick = () => endPlaying('back');
try {
  window.__TAURI__.event.listen('game-exited', (e) => {
    if (playing && playing.id === e.payload) endPlaying('exit');
    refreshGames();   // pick up the new play time (also when you already went back to the launcher)
  });
} catch (err) {}
let hoverDock = false;   // true when the dock cursor came from the mouse (so leaving gives it back)
dockBtns.forEach((b, i) => {
  b.addEventListener('mouseenter', () => {
    if (zone === 'dock' && dockIdx === i) return;
    if (zone !== 'dock') hoverDock = true;
    zone = 'dock'; dockIdx = i; sfx.move(); update(false);
  });
  b.addEventListener('mouseleave', () => {
    if (hoverDock && zone === 'dock' && games.length) { zone = 'rail'; update(false); }
    hoverDock = false;
  });
});

function tick() {
  const d = new Date();
  $('#time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  $('#wifi').classList.toggle('off', !navigator.onLine);
}
navigator.getBattery?.().then((b) => {
  const u = () => { $('#batt').hidden = b.charging && b.level >= 1; $('#batt').textContent = `${Math.round(b.level * 100)}%`; };
  u(); b.addEventListener('levelchange', u); b.addEventListener('chargingchange', u);
}).catch(() => {});

/* ================= input: keyboard, wheel, gamepad ================= */
addEventListener('keydown', (e) => {
  if (scanOpen()) {
    const k = e.key;
    if (scan.phase !== 'busy') {
      if (k === 'ArrowDown') { e.preventDefault(); moveScan(1); }
      else if (k === 'ArrowUp') { e.preventDefault(); moveScan(-1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); activateScan(); }
      else if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); scanBack(); }
    }
    return;
  }
  if (!$('#stats').hidden) {
    if (['Escape', 'Backspace', 'Enter', ' ', 's', 'S'].includes(e.key)) { e.preventDefault(); closeStats(); }
    return;
  }
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeRename(); return; }
  if (!menu.hidden) {
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const bs = [...menu.querySelectorAll('button')].filter((x) => !x.hidden);
      const i = bs.indexOf(document.activeElement), d = e.key === 'ArrowDown' ? 1 : -1;
      bs[(i + d + bs.length) % bs.length].focus();
    }
    return;
  }
  if (overlayOpen) { if (playing && (e.key === 'Escape' || e.key === 'Backspace')) endPlaying('back'); return; }
  const k = e.key;
  if (k === 'ArrowRight') nav(1);
  else if (k === 'ArrowLeft') nav(-1);
  else if (k === 'ArrowDown') vert(1);
  else if (k === 'ArrowUp') vert(-1);
  else if (k === 'Home' && zone === 'rail') select(0);
  else if (k === 'End' && zone === 'rail') select(games.length - 1);
  else if (k === 'Enter' || k === ' ') { e.preventDefault(); enter(); }
  else if (k === 'Escape' || k === 'Backspace') back();
  else if ((k === 'Delete' || k === 'ContextMenu' || k.toLowerCase() === 'x') && zone === 'rail') openMenu();
  else if (k.toLowerCase() === 'n' || k === '+') addGames();
  else if (k.toLowerCase() === 's') openStats();
  else if (k.toLowerCase() === 'f') openScan();
  else if (k.toLowerCase() === 't') $('#btnTheme').click();
  else if (k.toLowerCase() === 'o') $('#btnSort').click();
  else if (k.toLowerCase() === 'l') $('#btnLayout').click();
  else if (k.toLowerCase() === 'm') $('#btnSound').click();
  else if (k === 'F11') { e.preventDefault(); toggleFullscreen(); }
});
let wheelLock = 0;
addEventListener('wheel', (e) => {
  const now = performance.now(); if (now - wheelLock < 140 || overlayOpen || !$('#stats').hidden || scanOpen()) return;
  wheelLock = now; nav((e.deltaY || e.deltaX) > 0 ? 1 : -1);
}, { passive: true });
addEventListener('resize', () => update(true));
addEventListener('online', tick); addEventListener('offline', tick);

const pad = { held: {}, next: 0, nextV: 0 };
function poll() {
  const p = [...(navigator.getGamepads?.() || [])].find(Boolean);
  if (p) {
    const b = (i) => p.buttons[i]?.pressed;
    if (p.buttons.some((x) => x.pressed) || Math.abs(p.axes[0] || 0) > .5 || Math.abs(p.axes[1] || 0) > .5) poke();
    const press = (key, down, fn) => { if (down && !pad.held[key]) fn(); pad.held[key] = down; };
    if (playing) {
      if (document.hasFocus()) {
        press('b', b(1), () => endPlaying('back'));
        press('l2', b(6), () => spinMascot('l')); press('r2', b(7), () => spinMascot('r'));
      }
    } else if (scanOpen()) {
      const ay = p.axes[1] || 0, now = performance.now(), live = () => scan.phase !== 'busy';
      const vdir = b(13) || ay > .6 ? 1 : b(12) || ay < -.6 ? -1 : 0;
      if (vdir && now > pad.nextV) { if (live()) moveScan(vdir); pad.nextV = now + 150; } else if (!vdir) pad.nextV = 0;
      press('a', b(0), () => live() && activateScan());
      press('b', b(1), () => live() && scanBack());
      press('start', b(9), () => live() && scan.phase === 'results' && addPicked());
      pad.held.x = b(2); pad.held.y = b(3);
    } else if (!$('#stats').hidden) {
      press('b', b(1), closeStats);
      pad.held.a = b(0); pad.held.x = b(2); pad.held.y = b(3);
    } else if ($('#modal').hidden && menu.hidden && !overlayOpen) {
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0, now = performance.now();
      const dir = b(15) || ax > .6 ? 1 : b(14) || ax < -.6 ? -1 : 0;
      if (dir && now > pad.next) { nav(dir); pad.next = now + 190; } else if (!dir) pad.next = 0;
      press('up', b(12) || ay < -.6, () => vert(-1));
      press('down', b(13) || ay > .6, () => vert(1));
      press('a', b(0), enter);
      press('b', b(1), back);
      press('x', b(2), () => zone === 'rail' && openMenu());
      press('y', b(3), addGames);
      press('l1', b(4), () => $('#btnLayout').click()); press('r1', b(5), () => $('#btnSort').click());
      press('l2', b(6), () => spinMascot('l')); press('r2', b(7), () => spinMascot('r'));   // triggers spin the mascot
    } else {
      pad.held.a = b(0); pad.held.b = b(1); pad.held.x = b(2); pad.held.y = b(3);
    }
  }
  requestAnimationFrame(poll);
}

/* ================= find games: scan this PC or a folder, tick what to add ================= */
const scan = { phase: 'choose', items: [], pick: new Set(), rows: [], cur: 0, already: 0 };
const scanOpen = () => !$('#scan').hidden;
function openScan() {
  if (busy || overlayOpen) return;
  scan.phase = 'choose'; scan.cur = 0; $('#scan').hidden = false; sfx.open(); renderScan();
}
function closeScan(silent) { if (!scanOpen()) return; $('#scan').hidden = true; if (!silent) sfx.back(); }
function scanBack() {
  if (scan.phase === 'results') { scan.phase = 'choose'; scan.cur = 0; sfx.back(); renderScan(); }
  else closeScan();
}
function moveScan(d) {
  const n = Math.max(0, Math.min(scan.rows.length - 1, scan.cur + d));
  if (n === scan.cur) return sfx.edge();
  scan.cur = n; sfx.move(); markScan();
}
function markScan() {
  [...$('#scanList').children].forEach((r, i) => r.classList.toggle('cur', i === scan.cur));
  $('#scanList').children[scan.cur]?.scrollIntoView({ block: 'nearest' });
}
function activateScan() {
  const r = scan.rows[scan.cur]; if (!r) return;
  if (r.disabled) return sfx.edge();
  r.go();
}
function renderScan() {
  const list = $('#scanList'), keep = list.scrollTop;
  list.replaceChildren();
  const lead = $('#scanLead'), note = $('#scanNote');
  const rows = [];
  if (scan.phase === 'choose') {
    lead.textContent = 'Where should I look?';
    note.textContent = 'Nothing is added until you pick the games.';
    rows.push({ title: 'This PC', sub: 'Steam, Epic Games and GOG', go: scanStores });
    rows.push({ title: 'A folder…', sub: 'Pick a folder like D:\\Games, each sub-folder counts as a game', go: scanFolder });
  } else if (scan.phase === 'busy') {
    lead.textContent = 'Looking…'; note.textContent = 'This can take a few seconds.';
  } else {
    const n = scan.items.length, p = scan.pick.size;
    lead.textContent = n ? `Found ${n} game${n === 1 ? '' : 's'}` : 'No new games found';
    note.textContent = scan.already ? `${scan.already} already in your launcher left out.` : '';
    if (n) {
      rows.push({ title: p === n ? 'Select none' : 'Select all', act: true, go: () => { scan.pick = p === n ? new Set() : new Set(scan.items.map((_, i) => i)); sfx.toggle(); renderScan(); } });
      scan.items.forEach((f, i) => rows.push({ f, go: () => { scan.pick.has(i) ? scan.pick.delete(i) : scan.pick.add(i); sfx.toggle(); renderScan(); }, on: scan.pick.has(i) }));
      rows.push({ title: p ? `Add ${p} game${p === 1 ? '' : 's'}` : 'Tick some games first', primary: true, disabled: !p, go: addPicked });
    }
    rows.push({ title: 'Look somewhere else', act: true, go: () => { scan.phase = 'choose'; scan.cur = 0; sfx.back(); renderScan(); } });
  }
  scan.rows = rows;
  scan.cur = Math.max(0, Math.min(scan.cur, rows.length - 1));
  rows.forEach((r, i) => {
    const row = el('div', 'srow' + (r.f ? (r.on ? ' on' : '') : r.primary ? ' primary' : ' act') + (r.disabled ? ' dis' : ''));
    if (r.f) {
      const chk = el('span', 'chk'), nm = el('span', 'nm'), tag = el('span', 'tag');
      chk.textContent = '\u2713'; nm.textContent = r.f.name; tag.textContent = r.f.source;
      row.append(chk, nm, tag);
    } else {
      const t = el('b', ''); t.textContent = r.title; row.append(t);
      if (r.sub) { const s = el('span', ''); s.textContent = r.sub; row.append(s); }
    }
    row.onmouseenter = () => { if (scan.cur !== i) { scan.cur = i; [...list.children].forEach((c, j) => c.classList.toggle('cur', j === i)); } };
    row.onclick = () => { scan.cur = i; activateScan(); };
    list.append(row);
  });
  list.scrollTop = keep; markScan();
}
function showFound(list) {
  scan.already = list.filter((f) => f.already).length;
  scan.items = list.filter((f) => !f.already);
  scan.pick = new Set(scan.items.map((_, i) => i));   // everything ticked, untick what you don't want
  scan.phase = 'results'; scan.cur = scan.items.length ? 1 : 0; renderScan();
}
async function scanStores() {
  scan.phase = 'busy'; renderScan();
  try { showFound(await invoke('scan_stores')); }
  catch (e) { toast(noCmd(e) ? 'Update main.rs first (scan commands are missing)' : String(e)); sfx.error(); scan.phase = 'choose'; scan.cur = 0; renderScan(); }
}
async function scanFolder() {
  scan.phase = 'busy'; renderScan();
  try {
    const list = await invoke('scan_folder');
    if (list === null) { scan.phase = 'choose'; renderScan(); return; }   // picker cancelled
    showFound(list);
  } catch (e) { toast(noCmd(e) ? 'Update main.rs first (scan commands are missing)' : String(e)); sfx.error(); scan.phase = 'choose'; scan.cur = 0; renderScan(); }
}
async function addPicked() {
  const items = [...scan.pick].sort((a, b) => a - b).map((i) => scan.items[i]);
  if (!items.length) return;
  scan.phase = 'busy'; renderScan();
  const before = new Set(games.map((g) => g.id));
  let list;
  try { list = await invoke('add_found', { items }); }
  catch (e) { toast(String(e)); sfx.error(); scan.phase = 'results'; renderScan(); return; }
  games = mergeCovers(list);
  const first = games.findIndex((g) => !before.has(g.id)), n = games.filter((g) => !before.has(g.id)).length;
  zone = 'rail'; sel = first >= 0 ? first : 0;
  closeScan(true); render(); sfx.add(); cheer(2200);
  toast(n ? `Added ${n} game${n === 1 ? '' : 's'}` : 'Those games were already added');
}
$('#scanClose').onclick = () => closeScan();
$('#scan').addEventListener('mousedown', (e) => { if (e.target.id === 'scan' && scan.phase !== 'busy') closeScan(); });

/* ================= play time: refresh, stats panel ================= */
async function refreshGames() {
  const keep = games[sel] && games[sel].id;
  const before = new Map(games.map((g) => [g.id, g.total_secs || 0]));
  let list; try { list = await invoke('list_games'); } catch (e) { return; }
  games = mergeCovers(list);
  const i = games.findIndex((g) => g.id === keep);
  if (i >= 0) sel = i;
  render();
  games.forEach((g) => {
    const a = tierOf(before.get(g.id) || 0), b = tierOf(g.total_secs);
    if (b && (!a || b.n > a.n)) { toast(`New sticker: ${g.name} hit ${b.n} hours`); sfx.milestone(); cheer(2800); }
  });
}
function streak() {
  const days = new Set(); games.forEach((g) => (g.play_days || []).forEach((d) => days.add(d)));
  const today = dayNum(); let d = days.has(today) ? today : today - 1, n = 0;
  while (days.has(d)) { n++; d--; }
  return { n, today: days.has(today) };
}
function openStats() {
  const total = games.reduce((a, g) => a + (g.total_secs || 0), 0);
  const ranked = games.filter((g) => (g.total_secs || 0) >= 60).sort((a, b) => b.total_secs - a.total_secs);
  const top = ranked[0], st = streak();
  $('#statsLead').textContent = top ? `You've spent ${longDur(top.total_secs)} with ${top.name}.` : 'Play a game and your stats will show up here.';
  $('#stTotal').textContent = dur(total);
  $('#stTop').textContent = top ? top.name : '-';
  $('#stStreak').textContent = `${st.n} day${st.n === 1 ? '' : 's'}`;
  $('#stStreakSub').textContent = st.n ? (st.today ? 'in a row' : 'play today to keep it') : 'play today to start one';
  const bars = $('#stBars'); bars.replaceChildren();
  ranked.slice(0, 5).forEach((g) => {
    const row = el('div', 'brow'), name = el('span', ''), track_ = el('div', 'btrack'), fill = el('div', 'bfill'), t = el('span', 'bt');
    name.textContent = g.name; t.textContent = dur(g.total_secs);
    fill.style.setProperty('--w', `${Math.max(4, Math.round(g.total_secs / top.total_secs * 100))}%`);
    track_.append(fill); row.append(name, track_, t); bars.append(row);
  });
  $('#stats').hidden = false; sfx.open();
}
function closeStats() { if ($('#stats').hidden) return; $('#stats').hidden = true; sfx.back(); }
$('#statsClose').onclick = closeStats;
$('#stats').addEventListener('mousedown', (e) => { if (e.target.id === 'stats') closeStats(); });

/* ================= disc spin: hover makes it whirl, letting go it coasts to a stop ================= */
const SPIN_SELECTED = 24, SPIN_HOVER = 320;   // degrees per second (set SPIN_SELECTED to 0 for still discs)
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
let spinT = performance.now();
function spinLoop(now) {
  const dt = Math.min(.05, (now - spinT) / 1000); spinT = now;
  if (!calm) for (const t of track.children) {
    if (!t._sp) continue;
    const target = t._hover ? SPIN_HOVER : t.classList.contains('sel') ? SPIN_SELECTED : 0;
    const v = t._v || 0, k = target > v ? 7 : 1.8;   // spins up fast, coasts down slowly
    t._v = Math.abs(target - v) < .3 ? target : v + (target - v) * Math.min(1, dt * k);
    if (t._v) { t._a = ((t._a || 0) + t._v * dt) % 360; t._sp.style.transform = `rotate(${t._a}deg)`; }
  }
  requestAnimationFrame(spinLoop);
}

/* ================= mascot: sleeps when idle, wakes when you move, spins when happy ================= */
const mascot = $('#mascot'), lm = $('#lmascot');
let idleT = null, happyT = null, lmT = null, lmSleepT = null;
function mset(node, s) { node.dataset.s = ''; void node.offsetWidth; node.dataset.s = s; }   // re-triggers the animation
function poke() {
  if (mascot.dataset.s === 'sleep') mset(mascot, 'awake');
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (mascot.dataset.s === 'awake') mascot.dataset.s = 'sleep'; }, 40000);
  if (playing) {   // on the "now playing" screen it dozes off sooner
    if (lm.dataset.s === 'sleep') mset(lm, 'awake');
    clearTimeout(lmSleepT);
    lmSleepT = setTimeout(() => { if (playing) lm.dataset.s = 'sleep'; }, 15000);
  }
}
function cheer(ms = 2200, dir = 'r') {
  clearTimeout(happyT); mascot.dataset.dir = dir; mset(mascot, 'happy');
  happyT = setTimeout(() => { mset(mascot, 'awake'); poke(); }, ms);
}
['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, poke, { passive: true, capture: true }));
function spinMascot(dir = 'r') {   // 'l' = counter-clockwise (L2), 'r' = clockwise (R2, click)
  sfx.boop();
  if (playing) { lm.dataset.dir = dir; mset(lm, 'happy'); clearTimeout(lmT); lmT = setTimeout(() => { lm.dataset.s = 'awake'; }, 1600); }
  else cheer(1600, dir);
}
mascot.onclick = () => spinMascot('r');
lm.innerHTML = mascot.innerHTML;

/* ================= boot ================= */
(async function init() {
  setTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  setMuted(muted); setSort(sortMode, false); setLayout(layout, false);
  tick(); setInterval(tick, 15000);
  games = mergeCovers((await call('list_games')) || []);
  sel = 0; render(); poll(); requestAnimationFrame(spinLoop); cheer(2600); poke();
})();
