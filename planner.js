/* Rule-based planner. No AI, runs fully on-device. Works in browser and Node (for tests). */
(function (root) {
  const ORDER = ['SP', 'INT', 'HP', 'AS', 'MIX', 'AL', 'REST'];
  const SESSION = {
    SP: { name: 'Squat / Pull', heavy: true, src: 'Monday - Session #1' },
    INT: { name: 'Intervals', heavy: false, hard: true, src: 'Tuesday - Session #2' },
    HP: { name: 'Hinge / Push', heavy: true, src: 'Wednesday - Session #3' },
    AS: { name: 'Aerobic (short, <45 min Zone 2)', heavy: false, src: 'Thursday - Session #4' },
    MIX: { name: 'Mixed / Full body (25-min AMRAP)', heavy: true, src: 'Friday - Session #5' },
    AL: { name: 'Aerobic (long, 45+ min Zone 2)', heavy: false, src: 'Saturday - Session #6' },
    REST: { name: 'Rest / Active recovery', heavy: false, src: 'Sunday - Session #7' },
  };
  const SPLIT_URL = 'https://www.everydayheroesfitness.com/resources/7-day-functional-training-split-first-responders';
  const HOME_EQ = ['DB', 'BW', 'Run'];
  const STATION_EQ = ['KB', 'DB', 'BW', 'Barbell', 'Pullup bar', 'Machine', 'Band', 'Gear'];
  const HOME_DBS = [45, 35, 25, 20, 15];

  // ---------- dates ----------
  const iso = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const dow = s => parse(s).getDay();

  function dayType(date, shifts) {
    if (shifts.has(date)) return 'shift';
    if (shifts.has(addDays(date, -1))) return 'post';
    return 'off';
  }

  // ---------- seeded random ----------
  function rng(seedStr) { let h = 2166136261; for (const c of seedStr) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; }; }

  // ---------- move picking ----------
  function usable(m, loc) {
    const eq = loc === 'home' ? HOME_EQ : STATION_EQ;
    return m.equipment.some(e => eq.includes(e));
  }
  function eqLabel(m, loc) {
    const eq = loc === 'home' ? HOME_EQ : STATION_EQ;
    const pref = loc === 'home' ? ['DB', 'BW', 'Run'] : ['Barbell', 'KB', 'DB', 'Pullup bar', 'Machine', 'BW', 'Band', 'Gear', 'Run'];
    return pref.find(e => m.equipment.includes(e) && eq.includes(e)) || m.equipment[0];
  }

  function makePicker(moves, ctx) {
    const byId = Object.fromEntries(moves.map(m => [m.id, m]));
    const used = new Set(ctx.recent || []);
    const r = rng(ctx.seed);
    function ok(m, opts) {
      if (!usable(m, ctx.loc)) return false;
      if (ctx.knee && m.kneeStress) return false;
      if (opts.heavy && !m.heavy) return false;
      if (opts.notEq && m.equipment.length === 1 && m.equipment[0] === opts.notEq) return false;
      return true;
    }
    function pick(cat, opts = {}) {
      // exact (Week A) preferred id first
      if (opts.prefer) for (const id of [].concat(opts.prefer)) { const m = byId[id]; if (m && ok(m, opts) && !ctx.taken.has(id)) { ctx.taken.add(id); return m; } }
      let pool = moves.filter(m => m.category === cat && ok(m, opts) && !ctx.taken.has(m.id));
      if (ctx.knee && cat === 'squat') { const kp = pool.filter(m => m.knee); if (kp.length) pool = kp; }
      let fresh = pool.filter(m => !used.has(m.id));
      if (!fresh.length) fresh = pool;
      if (!fresh.length) return null;
      const m = fresh[Math.floor(r() * fresh.length)];
      ctx.taken.add(m.id); return m;
    }
    return { pick, byId };
  }

  function item(m, loc, rx, extra) {
    return Object.assign({ id: m.id, name: m.name, category: m.category, equip: eqLabel(m, loc), rx, explain: m.explain, source: m.source, url: m.url, eh: m.eh }, extra || {});
  }
  function load(m, loc, heavy) {
    if (loc !== 'home') return '';
    const e = eqLabel(m, loc);
    if (e !== 'DB') return '';
    return heavy ? ' @ 45 lb DB' : (m.category === 'push' || m.category === 'core' ? ' @ 25-35 lb DB' : ' @ 35 lb DB');
  }

  // ---------- warm-up / cooldown ----------
  function warmup(P, loc, knee) {
    const a = P.pick('mobility', { prefer: 'hip_9090' });
    const b = P.pick('squat', { prefer: 'heels_elev_squat' });
    const c = P.pick('push', { prefer: loc === 'home' ? 'hand_release_pushup' : 'pushup' });
    return [item(a, loc, '5 per side x 2'), item(b, loc, '2 rounds x 10 (bodyweight)'), item(c, loc, '2 rounds x 10')];
  }
  function cooldown(P, loc) {
    return [item(P.pick('mobility', { prefer: 'couch_stretch' }), loc, '1 min per side'),
      item(P.pick('mobility', { prefer: 'cat_cow' }), loc, '1 min'),
      item(P.pick('mobility', { prefer: 'thread_needle' }), loc, '1 min per side')];
  }

  const REST_NOTE = 'App guidance (not from EH, whose pages list no rest periods): do 1a then 1b, rest 60-90 s, repeat for 3 rounds, then move to the next pair. Rest ~2 min after heavy sets (main squat/deadlift).';

  // ---------- session builders ----------
  function build(type, o) {
    const { moves, loc, weekIndex, knee } = o;
    const ctx = { loc, knee, recent: o.recent || [], seed: o.date + type + weekIndex + (o.salt || ''), taken: new Set() };
    const P = makePicker(moves, ctx);
    const A = weekIndex === 0 && !o.salt; // Week A = site's exact session where equipment allows
    const w = { type, title: SESSION[type].name, loc, heavy: SESSION[type].heavy, srcNote: 'EH 7-Day Split, ' + SESSION[type].src, srcUrl: SPLIT_URL, warmup: [], blocks: [], conditioning: null, cooldown: [], finisher: null, notes: [] };
    const pair = (label, a, b, rxA, rxB) => ({ label, kind: 'superset', rounds: 3, items: [item(a, loc, rxA + load(a, loc)), item(b, loc, rxB + load(b, loc))] });
    if (type === 'SP') {
      w.warmup = warmup(P, loc, knee);
      const sq1 = P.pick('squat', { prefer: A ? (loc === 'home' ? ['goblet_squat'] : ['dbl_front_rack_squat']) : (loc === 'station' ? ['barbell_front_squat', 'barbell_back_squat'] : []), heavy: !knee });
      const pu1 = P.pick('pull', { prefer: A ? (loc === 'home' ? ['bench_row'] : ['pullup']) : [] });
      const sq2 = P.pick('squat', { prefer: A ? ['bulgarian_split_squat', 'reverse_lunge'] : [] });
      const pu2 = P.pick('pull', { prefer: A ? ['gorilla_row'] : [] });
      const sq3 = P.pick('squat', { prefer: A ? ['cossack_squat'] : [] });
      const pu3 = P.pick('pull', { prefer: A ? ['kb_curl_pullover'] : [] });
      const sq4 = P.pick('squat', { prefer: A ? ['tempo_goblet_squat'] : [] });
      const pu4 = P.pick('pull', { prefer: A ? ['kb_high_pull'] : [] });
      w.blocks = [pair('1', sq1, pu1, '3 x 8-12', pu1.id === 'pullup' ? '3 x AMRAP' : '3 x 8-12'), pair('2', sq2, pu2, '3 x 8-12' + (sq2.perSide ? ' per side' : ''), '3 x 10 per side'), pair('3', sq3, pu3, '3 x 6-10' + (sq3.perSide ? ' per side' : ''), '3 x 8-12'), pair('4', sq4, pu4, '3 x 6-10', '3 x 8-12')];
      w.blocks[0].heavyRest = true;
      w.cooldown = cooldown(P, loc);
    } else if (type === 'HP') {
      w.warmup = warmup(P, loc, knee);
      const h = loc === 'station' ? P.pick('hinge', { prefer: A ? ['trap_bar_deadlift', 'barbell_deadlift'] : ['barbell_deadlift', 'trap_bar_deadlift'] }) : P.pick('hinge', { prefer: ['kb_deadlift'] });
      w.blocks.push({ label: '1', kind: 'straight', rounds: 5, heavyRest: true, items: [item(h, loc, (loc === 'home' ? '5 x 8 @ 45 lb DB (home: higher reps)' : '5 x 5'))] });
      const p2 = P.pick('push', { prefer: A ? ['glute_bridge_floor_press'] : [] });
      const h2 = P.pick('hinge', { prefer: A ? ['b_stance_rdl'] : ['single_leg_rdl', 'b_stance_rdl'] });
      const p3 = P.pick('push', { prefer: A ? ['clean_to_press'] : [] });
      const c3 = P.pick('core', { prefer: A ? ['halo_rotation'] : [] });
      w.blocks.push(pair('2', p2, h2, '3 x 8-12', '3 x 8-12' + (h2.perSide ? ' per side' : '')));
      w.blocks.push(pair('3', p3, c3, '3 x 6-10' + (p3.perSide ? ' per side' : ''), '3 x 12-15'));
      w.conditioning = { title: 'Finisher: EMOM x 6 (EH)', text: 'Every minute for 6 minutes: 10 swings + 10 push-ups.' + (loc === 'home' ? ' Swing the 35 lb DB by one end.' : ''), src: 'EH 7-Day Split, Wednesday' };
      w.cooldown = cooldown(P, loc);
    } else if (type === 'MIX') {
      w.warmup = warmup(P, loc, knee);
      const list = A ? [['kb_deadlift', 'hinge'], ['single_arm_row', 'pull'], ['kb_clean', 'hinge'], ['goblet_squat', 'squat'], ['russian_swing', 'hinge']]
        : [['', 'hinge'], ['', 'pull'], ['', 'push'], ['', 'squat'], ['', 'carry']];
      const its = list.map(([id, c]) => { const m = P.pick(c, { prefer: id ? [id] : [] }); return item(m, loc, '10 reps' + (m.category === 'carry' ? ' (or 50 ft)' : '')); });
      w.blocks.push({ label: 'AMRAP', kind: 'amrap', minutes: 25, items: its });
      w.notes.push('Single bell, medium-heavy: ' + (loc === 'home' ? '35 or 45 lb DB.' : '53 lb KB.') + ' As many rounds as possible in 25 minutes; log your rounds.');
      w.cooldown = cooldown(P, loc);
    } else if (type === 'INT') {
      const machines = loc === 'station' ? ['SkiErg', 'Rower', 'Assault bike/StairMaster'] : (knee ? ['Brisk uphill walk (knee day)'] : ['Outdoor run (track or flat road)', 'Hill sprints']);
      const fmt = A ? '15 rounds: 30 s ON (RPE 8-9) / 30 s OFF (RPE 2-3)' : [
        '15 rounds: 30 s ON (RPE 8-9) / 30 s OFF (RPE 2-3)', 'Fartlek: 3 min hard / 1 min easy x 5', 'Pyramid 1-2-3-4-3-2-1 min hard, 90 s easy between', '6 x 3 min at 8-10/10 effort, 90 s rest'][weekIndex % 4];
      w.conditioning = { title: 'Intervals', text: '5 min easy warm-up. ' + fmt + '. 4 min cooldown. Machine: ' + machines[weekIndex % machines.length] + '.', src: weekIndex % 4 === 0 || A ? 'EH 7-Day Split, Tuesday' : 'EH: Why Firefighters NEED Elite VO2 Max' };
      w.cooldown = cooldown(P, loc);
    } else if (type === 'AS' || type === 'AL') {
      const post = o.dayType === 'post';
      const mode = loc === 'station' ? ['StairMaster', 'Rower', 'Treadmill', 'SkiErg'][weekIndex % 4] : (post || knee ? 'Brisk walk outside (hills if any)' : (type === 'AL' && weekIndex % 2 ? 'Ruck or long walk' : 'Easy run outside'));
      const mins = type === 'AS' ? '30-40 min' : '45-60 min';
      w.conditioning = { title: 'Zone 2', text: mins + ' Zone 2: ' + mode + '. Heart rate about 145 bpm (180 minus age) or a pace where you can hold a full sentence' + (type === 'AL' ? ', nasal breathing.' : '.'), src: 'EH 7-Day Split' + (post ? ' + EH 10K FAQ (no running the morning after a full shift)' : '') };
      w.cooldown = cooldown(P, loc);
      if (post) w.notes.push('Post-shift: EH says never run the morning after a full shift, so this is a walk.');
    } else {
      w.conditioning = { title: 'Active recovery', text: 'Mobility, yoga, ruck, or a long easy walk. Move without adding stress. Optional: EH Mobility Masterclass (10-12 min).', src: 'EH 7-Day Split, Sunday' };
      w.cooldown = [item(P.pick('mobility', { prefer: 'cat_cow' }), loc, '1 min'), item(P.pick('mobility', { prefer: 'couch_stretch' }), loc, '1 min per side'), item(P.pick('mobility', { prefer: 'hip_9090' }), loc, '5 per side x 2'), item(P.pick('mobility', { prefer: 'thread_needle' }), loc, '1 min per side')];
    }
    if (w.blocks.some(b => b.kind === 'superset')) w.restNote = REST_NOTE;
    if (['SP', 'HP', 'MIX'].includes(type)) {
      const fp = P.pick('push', {}); const fq = P.pick('pull', {});
      w.finisher = { title: 'Optional 21-15-12 finisher', items: [item(fp, loc, '21-15-12'), item(fq, loc, '21-15-12')], note: 'Approved non-EH format.' };
    }
    return w;
  }

  // ---------- modifiers ----------
  function shorten(w, minutes) {
    const c = JSON.parse(JSON.stringify(w));
    c.short = minutes;
    c.blocks = c.blocks.slice(0, 2).map(b => b.kind === 'amrap' ? Object.assign(b, { minutes: Math.min(b.minutes, minutes === 20 ? 15 : 12) }) : Object.assign(b, { rounds: 2 }));
    c.warmup = c.warmup.slice(0, 1); c.finisher = null; c.cooldown = c.cooldown.slice(0, 1);
    if (c.conditioning && /Zone 2/.test(c.conditioning.title)) c.conditioning.text = c.conditioning.text.replace(/\d+-\d+ min/, minutes + ' min');
    if (c.type === 'HP') c.conditioning = null;
    c.notes.push(minutes === 20 ? 'Only 20 min: first two blocks, 2 rounds each.' : 'Called out: shortened to the essentials.');
    return c;
  }

  // ---------- weekly plan ----------
  // Assign sessions to 7 days: hold EH order, slide heavy ones off shift/post days.
  function assignCycle(startDate, queueIn, shifts) {
    let queue = queueIn.slice();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(startDate, i);
      const t = dayType(date, shifts);
      if (!queue.length) queue = ORDER.slice();
      let pickIdx;
      if (t === 'off' && dow(date) === 0) {
        pickIdx = queue.indexOf('REST'); // off-shift Sunday = rest
        if (pickIdx < 0) { days.push({ date, dayType: t, type: 'REST', extraRest: true }); continue; }
      } else if (t === 'off') {
        pickIdx = 0;
        if (queue[0] === 'REST') { const h = queue.findIndex(s => SESSION[s].heavy); if (h > 0) pickIdx = h; }
      } else {
        // shift / post: first light session in order; intervals allowed on shift (station machines) not post.
        pickIdx = queue.findIndex(s => !SESSION[s].heavy && !(t === 'post' && s === 'INT') && s !== 'REST');
        if (pickIdx < 0) pickIdx = queue.indexOf('REST');
        if (pickIdx < 0) { days.push({ date, dayType: t, type: t === 'shift' ? 'AS' : 'REST', filler: true }); continue; }
      }
      const s = queue.splice(pickIdx, 1)[0];
      days.push({ date, dayType: t, type: s });
    }
    return { days, queueOut: queue };
  }

  function buildCycle(state, moves, startDate, opts = {}) {
    const shifts = new Set(state.shifts || []);
    const weekIndex = opts.weekIndex != null ? opts.weekIndex : (state.weekIndex || 0);
    const { days, queueOut } = assignCycle(startDate, opts.queue || state.queue || ORDER.slice(), shifts);
    const recent = recentMoves(state, startDate);
    for (const d of days) {
      const loc = (state.locOverride && state.locOverride[d.date]) || (d.dayType === 'shift' ? 'station' : 'home');
      d.workout = build(d.type, { moves, loc, weekIndex, date: d.date, recent, dayType: d.dayType });
    }
    return { start: startDate, weekIndex, days, queueOut };
  }
  function allMoveIds(w) { return [].concat(w.warmup, ...w.blocks.map(b => b.items), w.cooldown).filter(Boolean).filter(i => i.category !== 'mobility').map(i => i.id); }
  function recentMoves(state, before) {
    const out = []; const lo = addDays(before, -7);
    for (const c of state.cycles || []) for (const d of c.days) if (d.date >= lo && d.date < before) out.push(...allMoveIds(d.workout));
    return out;
  }

  root.Planner = { ORDER, SESSION, HOME_EQ, STATION_EQ, HOME_DBS, iso, parse, addDays, dow, dayType, build, shorten, assignCycle, buildCycle, allMoveIds, recentMoves, usable };
  if (typeof module !== 'undefined') module.exports = root.Planner;
})(typeof window !== 'undefined' ? window : globalThis);
