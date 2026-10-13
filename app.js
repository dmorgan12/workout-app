(() => {
  const P = window.Planner;
  const KEY = 'ehWorkoutApp.v1';
  const BASE = new URL('.', document.currentScript.src).href;
  let MOVES = [];
  let S = load();
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const today = () => window.__TODAY__ || P.iso(new Date());
  function load() { try { return Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { return defaults(); } }
  function defaults() { return { shifts: [], syncMethod: 'none', feedUrl: '', keyword: '', cycles: [], queue: null, weekIndex: 0, log: {}, mods: {}, locOverride: {}, knee: {}, view: 'today', sel: null }; }
  function save() { localStorage.setItem(KEY, JSON.stringify(S)); }
  const fmtDate = s => P.parse(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  // ---------- plan management ----------
  function lastCycle() { return S.cycles[S.cycles.length - 1]; }
  function ensurePlan() {
    const t = today();
    if (!S.cycles.length) newCycle(t);
    // build forward until today is covered
    let guard = 0;
    while (lastCycle() && P.addDays(lastCycle().start, 6) < t && guard++ < 60) newCycle(P.addDays(lastCycle().start, 7));
    // always keep the next 7 days (today..today+6) planned
    const horizon = P.addDays(t, 6); let g2 = 0;
    while (lastCycle() && P.addDays(lastCycle().start, 6) < horizon && g2++ < 10) newCycle(P.addDays(lastCycle().start, 7));
    save();
  }
  function newCycle(start) {
    const wi = S.cycles.length ? lastCycle().weekIndex + 1 : 0;
    const queue = S.cycles.length ? lastCycle().queueOut : P.ORDER.slice();
    const c = P.buildCycle({ shifts: S.shifts, cycles: S.cycles, locOverride: S.locOverride }, MOVES, start, { weekIndex: wi, queue });
    S.cycles.push(c);
    if (S.cycles.length > 16) S.cycles.shift();
    return c;
  }
  function cycleFor(date) { return S.cycles.find(c => date >= c.start && date <= P.addDays(c.start, 6)); }
  function dayFor(date) { const c = cycleFor(date); return c && c.days.find(d => d.date === date); }
  // Rebuild remaining days (from `from`) of the cycle containing it, and drop later cycles (they regenerate).
  function rebuildFrom(from, pushFront) {
    const c = cycleFor(from); if (!c) return;
    const idx = S.cycles.indexOf(c);
    const keep = c.days.filter(d => d.date < from);
    // queue = sessions not yet done in this cycle before `from` + leftover from previous cycle
    const prevQ = idx > 0 ? S.cycles[idx - 1].queueOut : P.ORDER.slice();
    let q = prevQ.slice(); if (!q.length) q = P.ORDER.slice();
    for (const d of keep) { const i = q.indexOf(d.type); if (i >= 0) q.splice(i, 1); if (!q.length && d !== keep[keep.length - 1]) q = P.ORDER.slice(); }
    if (pushFront) q.unshift(pushFront);
    const n = 7 - keep.length;
    const tmp = P.buildCycle({ shifts: S.shifts, cycles: S.cycles.slice(0, idx), locOverride: S.locOverride }, MOVES, from, { weekIndex: c.weekIndex, queue: q });
    c.days = keep.concat(tmp.days.slice(0, n));
    // recompute queueOut from remaining
    const rem = P.assignCycle(from, q, new Set(S.shifts));
    const used = c.days.filter(d => d.date >= from).map(d => d.type);
    let qo = q.slice(); used.forEach(t => { const i = qo.indexOf(t); if (i >= 0) qo.splice(i, 1); });
    c.queueOut = qo;
    S.cycles = S.cycles.slice(0, idx + 1);
    ensurePlan();
  }
  function fullRebuild() { const t = today(); S.cycles = S.cycles.filter(c => P.addDays(c.start, 6) < t); if (!S.cycles.length) newCycle(t); else newCycle(P.addDays(lastCycle().start, 7)); ensurePlan(); }

  function workoutFor(d) {
    let w = d.workout;
    const m = S.mods[d.date] || {};
    if (m.loc && m.loc !== w.loc || S.knee[d.date]) {
      w = P.build(d.type, { moves: MOVES, loc: m.loc || w.loc, weekIndex: cycleFor(d.date).weekIndex, date: d.date, knee: !!S.knee[d.date], dayType: d.dayType, salt: (m.loc || '') + (S.knee[d.date] ? 'k' : '') });
    } else w = JSON.parse(JSON.stringify(w));
    for (const [k, id] of Object.entries(m.swaps || {})) {
      const [sec, bi, ii] = k.split('.').map(x => isNaN(x) ? x : +x);
      const mv = MOVES.find(x => x.id === id); if (!mv) continue;
      const arr = sec === 'b' ? w.blocks[bi] && w.blocks[bi].items : sec === 'f' ? w.finisher && w.finisher.items : w[sec];
      if (arr && arr[ii]) arr[ii] = Object.assign({}, arr[ii], { id: mv.id, name: mv.name, category: mv.category, explain: mv.explain, source: mv.source, url: mv.url, eh: mv.eh, swapped: true, equip: mv.equipment.find(e => (w.loc === 'home' ? P.HOME_EQ : P.STATION_EQ).includes(e)) });
    }
    if (m.short) w = P.shorten(w, m.short);
    return w;
  }

  // ---------- rendering ----------
  function render() {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
    const v = S.view;
    $('#main').innerHTML = v === 'week' ? weekView() : v === 'log' ? logView() : v === 'schedule' ? scheduleView() : todayView(S.sel || today());
    window.scrollTo(0, 0);
  }
  const typeBadge = d => `<span class="badge t-${d.type}">${esc(P.SESSION[d.type].name)}</span>`;
  const dtLabel = { shift: 'Shift day · station', post: 'Post-shift · home', off: 'Off day · home' };

  function moveRow(it, key, date, logged) {
    const lg = (logged && logged.moves && logged.moves[key]) || {};
    return `<div class="move">
      <div class="mhead"><b>${esc(it.name)}</b> <span class="rx">${esc(it.rx)}</span></div>
      <div class="meta"><span class="eq">${esc(it.equip)}</span>${it.swapped ? '<span class="eq sw">swapped</span>' : ''}</div>
      <p class="explain">${esc(it.explain)}</p>
      <p class="src">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.source)}</a>` : esc(it.source)}</p>
      ${key ? `<div class="mlog"><input inputmode="decimal" placeholder="lb" data-ml="${key}" data-f="w" value="${esc(lg.w)}"><input inputmode="numeric" placeholder="reps" data-ml="${key}" data-f="r" value="${esc(lg.r)}"><button class="sm" data-swap="${key}">Swap</button></div>` : ''}
    </div>`;
  }
  function todayView(date) {
    ensurePlan();
    const d = dayFor(date);
    if (!d) return `<p>No plan for ${date}.</p>`;
    const w = workoutFor(d); const lg = S.log[date] || {}; const m = S.mods[date] || {};
    let h = `<header class="dayhead"><div class="date">${date === today() ? 'Today · ' : ''}${fmtDate(date)}</div>${typeBadge(d)}<div class="dt">${dtLabel[d.dayType]}${w.loc !== (d.dayType === 'shift' ? 'station' : 'home') ? ' → ' + w.loc : ''}</div>
      ${lg.status ? `<div class="status s-${lg.status}">${lg.status}</div>` : ''}</header>
      <div class="toggles">
        <button data-act="called" class="${m.short === 12 ? 'on' : ''}">🚒 Called out—shorten</button>
        <button data-act="knee" class="${S.knee[date] ? 'on' : ''}">🦵 Knee is sore</button>
        <button data-act="20" class="${m.short === 20 ? 'on' : ''}">⏱ Only 20 min</button>
        <button data-act="loc">${w.loc === 'home' ? '🏢 At station instead' : '🏠 At home instead'}</button>
      </div>`;
    h += `<p class="src small">Session: <a href="${w.srcUrl}" target="_blank" rel="noopener">${esc(w.srcNote)}</a></p>`;
    w.notes.forEach(n => h += `<p class="note">${esc(n)}</p>`);
    if (w.warmup.length) h += `<h3>Warm-up</h3>` + w.warmup.map((it, i) => moveRow(it, 'warmup.' + i, date, lg)).join('');
    if (w.blocks.length) {
      h += `<h3>Main work</h3>`;
      w.blocks.forEach((b, bi) => {
        const lab = b.kind === 'superset' ? `Superset ${b.label}: ${b.rounds} rounds of the pair` : b.kind === 'amrap' ? `AMRAP ${b.minutes} min` : `Lift ${b.label}: ${b.rounds} sets`;
        h += `<div class="block"><div class="blab">${lab}${b.heavyRest ? ' · ~2 min rest (heavy)' : b.kind === 'superset' ? ' · 60-90 s rest between rounds' : ''}</div>` +
          b.items.map((it, ii) => moveRow(Object.assign({}, it, { name: (b.kind === 'superset' ? b.label + String.fromCharCode(97 + ii) + '. ' : '') + it.name }), 'b.' + bi + '.' + ii, date, lg)).join('') + `</div>`;
      });
      if (w.restNote) h += `<p class="note">${esc(w.restNote)}</p>`;
    }
    if (w.conditioning) h += `<h3>${esc(w.conditioning.title)}</h3><div class="block"><p>${esc(w.conditioning.text)}</p><p class="src">${esc(w.conditioning.src)}</p></div>`;
    if (w.finisher) h += `<details><summary>${esc(w.finisher.title)}</summary>${w.finisher.items.map((it, i) => moveRow(it, 'f.0.' + i, date, lg)).join('')}<p class="note">${esc(w.finisher.note)}</p></details>`;
    if (w.cooldown.length) h += `<h3>${d.type === 'REST' ? 'Mobility' : 'Cool-down'}</h3>` + w.cooldown.map((it, i) => moveRow(it, 'cooldown.' + i, date, lg)).join('');
    h += `<h3>Log</h3><div class="loggrid">
      ${['rounds', 'time', 'distance', 'cal'].map(f => `<label>${f === 'time' ? 'time (min)' : f === 'distance' ? 'distance' : f}<input data-lf="${f}" value="${esc(lg[f])}"></label>`).join('')}
      </div><textarea data-lf="notes" placeholder="Notes (how it felt, changes you made)">${esc(lg.notes)}</textarea>
      <div class="statusbtns"><button data-st="done" class="big ok">✓ Done</button><button data-st="partial" class="big">◐ Partial</button><button data-st="skipped" class="big no">✕ Skipped</button></div>
      ${d.type && P.SESSION[d.type].heavy ? '<p class="small">Skipping a heavy session rolls it forward to the next suitable off day.</p>' : ''}`;
    return h;
  }
  function weekView() {
    ensurePlan();
    const t = today(); const cs = S.cycles.filter(c => P.addDays(c.start, 6) >= P.addDays(t, -7));
    let h = `<div class="row"><button class="big" data-act="nextweek">Build next week</button></div>`;
    cs.forEach(c => {
      h += `<h3>Week of ${fmtDate(c.start)} <span class="small">(cycle ${c.weekIndex + 1}${c.weekIndex === 0 ? ', Week A' : ''})</span></h3>`;
      c.days.forEach(d => {
        const lg = S.log[d.date] || {}; const loc = (S.mods[d.date] && S.mods[d.date].loc) || d.workout.loc;
        h += `<button class="wday ${d.date === t ? 'today' : ''}" data-day="${d.date}"><div><b>${fmtDate(d.date)}</b> <span class="dtag d-${d.dayType}">${d.dayType}</span></div>${typeBadge(d)}<div class="small">${loc}${lg.status ? ' · ' + lg.status : ''}${d.date === P.addDays(c.start, 5) ? ' · next week builds today' : ''}</div></button>`;
      });
      h += `<div class="row"><button data-ics="${c.start}">Export this week (.ics)</button></div>`;
    });
    return h;
  }
  function logView() {
    const dates = Object.keys(S.log).sort().reverse();
    let h = `<div class="row"><button data-act="copylog">Copy log for Arnold</button><button data-act="mdlog">Download log (.md)</button></div>
      <div class="row"><button data-act="backup">Export backup (JSON)</button><label class="filebtn">Import backup<input type="file" accept=".json,application/json" id="impjson"></label></div>`;
    if (!dates.length) h += '<p class="small">Nothing logged yet.</p>';
    dates.forEach(dt => { const d = dayFor(dt); const l = S.log[dt]; h += `<div class="block" data-day="${dt}"><b>${fmtDate(dt)}</b> ${d ? typeBadge(d) : ''} <span class="status s-${l.status}">${l.status || '—'}</span><pre>${esc(logText(dt))}</pre></div>`; });
    return h;
  }
  function scheduleView() {
    const m = { none: 'None yet', feed: 'Calendar feed URL', ics: 'Imported .ics file', manual: 'Tapped on calendar', pattern: '24/48 pattern' };
    const base = S.calMonth || today().slice(0, 7);
    const [y, mo] = base.split('-').map(Number);
    const first = new Date(y, mo - 1, 1, 12); const startPad = first.getDay(); const dim = new Date(y, mo, 0).getDate();
    let cal = '<div class="cal">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => `<div class="ch">${x}</div>`).join('') + '<div></div>'.repeat(startPad);
    for (let i = 1; i <= dim; i++) { const ds = `${y}-${String(mo).padStart(2, '0')}-${String(i).padStart(2, '0')}`; const t = P.dayType(ds, new Set(S.shifts)); cal += `<button class="cd d-${t} ${ds === today() ? 'today' : ''}" data-tog="${ds}">${i}</button>`; }
    cal += '</div>';
    return `<div class="active">Active schedule source: <b>${m[S.syncMethod] || S.syncMethod}</b> · ${S.shifts.length} shift days</div>
    <h3>1. Tap shift days</h3><div class="row"><button data-mon="-1">‹</button><b>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b><button data-mon="1">›</button></div>${cal}
    <p class="small"><span class="dtag d-shift">shift</span> station · <span class="dtag d-post">post</span> light, home · <span class="dtag d-off">off</span> heavy OK</p>
    <h3>2. Repeat every 3rd day (24/48)</h3><div class="row"><input type="date" id="patStart" value="${S.patStart || today()}"><input type="number" id="patWeeks" value="12" style="width:5em"> weeks <button data-act="pattern">Apply</button></div>
    <h3>3. Calendar feed (WhenToWork / Google iCal)</h3><input id="feedUrl" placeholder="https://… or webcal://… .ics" value="${esc(S.feedUrl)}"><input id="kw" placeholder="Only events containing (optional, e.g. Shift)" value="${esc(S.keyword)}">
    <div class="row"><button data-act="fetchfeed">Fetch feed</button></div>
    <p class="small">Most calendar servers block direct fetches from a web app (CORS), so this often fails on iPhone. If it does, use option 4: download the .ics on your phone or computer and import it.</p>
    <h3>4. Import .ics file</h3><label class="filebtn big">Choose .ics file<input type="file" accept=".ics,text/calendar" id="impics"></label>
    <h3>Plan</h3><div class="row"><button data-act="rebuild">Rebuild plan from today</button><button data-act="clearshifts" class="no">Clear shifts</button></div>
    <p class="small">Shifts are 24h, 6am–6am. The day after a shift counts as post-shift (light). The app uses rules, not AI: EH 7-day order, heavy days slide off shift/post days.</p>`;
  }

  // ---------- logs & exports ----------
  function logText(date) {
    const d = dayFor(date); const l = S.log[date] || {}; if (!d) return '';
    const w = workoutFor(d); const lines = [`${date} ${P.SESSION[d.type].name} (${w.loc}) — ${l.status || 'not marked'}`];
    const names = {}; w.warmup.forEach((it, i) => names['warmup.' + i] = it.name); w.blocks.forEach((b, bi) => b.items.forEach((it, ii) => names['b.' + bi + '.' + ii] = it.name)); (w.finisher ? w.finisher.items : []).forEach((it, i) => names['f.0.' + i] = it.name); w.cooldown.forEach((it, i) => names['cooldown.' + i] = it.name);
    for (const [k, v] of Object.entries(l.moves || {})) if (v.w || v.r) lines.push(`- ${names[k] || k}: ${v.w ? v.w + ' lb' : ''}${v.w && v.r ? ' x ' : ''}${v.r ? v.r + ' reps' : ''}`);
    ['rounds', 'time', 'distance', 'cal'].forEach(f => l[f] && lines.push(`- ${f}: ${l[f]}`));
    const m = S.mods[date] || {}; const mods = []; if (m.short) mods.push(m.short === 20 ? 'only 20 min' : 'called out/shortened'); if (S.knee[date]) mods.push('knee sore'); if (m.loc) mods.push('at ' + m.loc); if (m.swaps) mods.push(Object.keys(m.swaps).length + ' swap(s)');
    if (mods.length) lines.push('- adjustments: ' + mods.join(', '));
    if (l.notes) lines.push('- notes: ' + l.notes);
    return lines.join('\n');
  }
  function allLogMd() { return '# Workout log\n\n' + Object.keys(S.log).sort().map(logText).join('\n\n') + '\n'; }
  function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function icsWeek(start) {
    const c = S.cycles.find(x => x.start === start); const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const escI = s => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
    let out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EH Workout App//EN', 'CALSCALE:GREGORIAN'];
    c.days.forEach(d => {
      const w = workoutFor(d); const ds = d.date.replace(/-/g, ''); const nd = P.addDays(d.date, 1).replace(/-/g, '');
      const desc = [w.title + ' (' + w.loc + ')'].concat(w.blocks.flatMap(b => b.items.map(i => i.name + ' ' + i.rx)), w.conditioning ? [w.conditioning.text] : []).join('\n');
      out.push('BEGIN:VEVENT', 'UID:eh-' + ds + '@workout-app', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ds, 'DTEND;VALUE=DATE:' + nd, 'SUMMARY:' + escI('🏋 ' + w.title), 'DESCRIPTION:' + escI(desc), 'END:VEVENT');
    });
    out.push('END:VCALENDAR'); return out.join('\r\n');
  }
  function parseICS(text, kw) {
    const un = text.replace(/\r?\n[ \t]/g, ''); const out = new Set();
    un.split('BEGIN:VEVENT').slice(1).forEach(ev => {
      const sum = (ev.match(/\nSUMMARY[^:]*:(.*)/) || [])[1] || '';
      if (kw && !sum.toLowerCase().includes(kw.toLowerCase())) return;
      const m = ev.match(/\nDTSTART([^:]*):(\d{8})(T(\d{6})(Z?))?/); if (!m) return;
      let d;
      if (m[3] && m[5]) { const s = m[2] + m[4]; d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12))); d = P.iso(d); }
      else d = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
      out.add(d);
    });
    return [...out].sort();
  }
  function setShifts(list, method) { S.shifts = [...new Set(list)].sort(); S.syncMethod = method; fullRebuild(); save(); }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600); }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('button,[data-day]'); if (!b) return;
    const ds = b.dataset; const date = S.sel || today();
    if (ds.v) { S.view = ds.v; if (ds.v === 'today') S.sel = null; save(); return render(); }
    if (ds.day && S.view !== 'today') { S.sel = ds.day; S.view = 'today'; save(); return render(); }
    if (ds.st) {
      const was = (S.log[date] || {}).status; S.log[date] = Object.assign(S.log[date] || {}, { status: ds.st, at: Date.now() });
      const d = dayFor(date);
      if (ds.st === 'skipped' && was !== 'skipped' && d && P.SESSION[d.type].heavy) { save(); rebuildFrom(P.addDays(date, 1), d.type); toast(P.SESSION[d.type].name + ' rolled forward'); }
      else toast('Marked ' + ds.st);
      save(); return render();
    }
    if (ds.swap) return swapDialog(date, ds.swap);
    if (ds.pick) { const m = S.mods[date] = S.mods[date] || {}; m.swaps = m.swaps || {}; m.swaps[ds.key] = ds.pick; $('#dlg').close(); save(); return render(); }
    if (ds.tog) { const set = new Set(S.shifts); set.has(ds.tog) ? set.delete(ds.tog) : set.add(ds.tog); S.shifts = [...set].sort(); S.syncMethod = 'manual'; save(); return render(); }
    if (ds.mon) { const [y, m] = (S.calMonth || today().slice(0, 7)).split('-').map(Number); const d = new Date(y, m - 1 + +ds.mon, 1); S.calMonth = P.iso(d).slice(0, 7); save(); return render(); }
    if (ds.ics) return download('workouts-' + ds.ics + '.ics', icsWeek(ds.ics), 'text/calendar');
    const a = ds.act; if (!a) return;
    const m = S.mods[date] = S.mods[date] || {};
    if (a === 'called') m.short = m.short === 12 ? 0 : 12;
    if (a === '20') m.short = m.short === 20 ? 0 : 20;
    if (a === 'knee') S.knee[date] = !S.knee[date];
    if (a === 'loc') { const d = dayFor(date); const cur = m.loc || d.workout.loc; m.loc = cur === 'home' ? 'station' : 'home'; m.swaps = {}; }
    if (a === 'nextweek') { newCycle(P.addDays(lastCycle().start, 7)); toast('Next week built'); }
    if (a === 'pattern') { const st = $('#patStart').value, wk = +$('#patWeeks').value || 12; S.patStart = st; const l = []; for (let i = 0; i < wk * 7; i += 3) l.push(P.addDays(st, i)); setShifts(l, 'pattern'); toast(l.length + ' shifts set'); }
    if (a === 'fetchfeed') {
      S.feedUrl = $('#feedUrl').value.trim(); S.keyword = $('#kw').value.trim(); save();
      try { const r = await fetch(S.feedUrl.replace(/^webcal:/, 'https:'), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); const l = parseICS(await r.text(), S.keyword); if (!l.length) throw new Error('no events'); setShifts(l, 'feed'); toast('Feed synced: ' + l.length + ' shifts'); }
      catch (err) { toast('Feed blocked (' + err.message + '). Import the .ics file instead.'); }
    }
    if (a === 'rebuild') { fullRebuild(); toast('Plan rebuilt'); }
    if (a === 'clearshifts') { S.shifts = []; S.syncMethod = 'none'; fullRebuild(); }
    if (a === 'copylog') { const t = allLogMd(); try { await navigator.clipboard.writeText(t); toast('Copied. Paste it to Arnold.'); } catch (_) { download('workout-log.md', t, 'text/markdown'); } }
    if (a === 'mdlog') download('workout-log.md', allLogMd(), 'text/markdown');
    if (a === 'backup') download('eh-workout-backup-' + today() + '.json', JSON.stringify(S, null, 1), 'application/json');
    save(); render();
  });
  document.addEventListener('input', e => {
    const t = e.target; const date = S.sel || today();
    if (t.dataset.ml) { const l = S.log[date] = S.log[date] || {}; l.moves = l.moves || {}; (l.moves[t.dataset.ml] = l.moves[t.dataset.ml] || {})[t.dataset.f] = t.value; save(); }
    if (t.dataset.lf) { (S.log[date] = S.log[date] || {})[t.dataset.lf] = t.value; save(); }
  });
  document.addEventListener('change', async e => {
    const t = e.target; if (!t.files || !t.files[0]) return; const txt = await t.files[0].text();
    if (t.id === 'impics') { const l = parseICS(txt, ($('#kw') || {}).value || S.keyword); if (!l.length) return toast('No events found'); setShifts(l, 'ics'); toast('Imported ' + l.length + ' shifts'); render(); }
    if (t.id === 'impjson') { try { S = Object.assign(defaults(), JSON.parse(txt)); save(); toast('Backup restored'); render(); } catch (_) { toast('Not a valid backup'); } }
  });
  function swapDialog(date, key) {
    const d = dayFor(date); const w = workoutFor(d); const [sec, bi, ii] = key.split('.').map(x => isNaN(x) ? x : +x);
    const cur = sec === 'b' ? w.blocks[bi].items[ii] : sec === 'f' ? w.finisher.items[ii] : w[sec][ii];
    const opts = MOVES.filter(m => m.category === cur.category && m.id !== cur.id && P.usable(m, w.loc) && !(S.knee[date] && m.kneeStress)).sort((a, b) => (b.eh - a.eh) || a.name.localeCompare(b.name));
    $('#dlg').innerHTML = `<h3>Swap ${esc(cur.name)}</h3><p class="small">Same category (${cur.category}), ${w.loc} equipment.</p>` + opts.map(m => `<button class="opt" data-pick="${m.id}" data-key="${key}"><b>${esc(m.name)}</b>${m.eh ? '' : ' <span class="eq">non-EH exception</span>'}<br><span class="small">${esc(m.explain)}</span></button>`).join('') + '<button class="big" onclick="this.closest(\'dialog\').close()">Cancel</button>';
    $('#dlg').showModal();
  }

  async function init() {
    MOVES = await (await fetch(BASE + 'data/moves.json')).json();
    const h = location.hash.slice(1); if (['today', 'week', 'log', 'schedule'].includes(h)) S.view = h;
    ensurePlan(); render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register(BASE + 'service-worker.js');
  }
  window.EHApp = { get state() { return S; }, ensurePlan, newCycle, dayFor, workoutFor, parseICS, icsWeek, rebuildFrom };
  init();
})();
