#!/usr/bin/env node
/**
 * watch-report.js, who watched a demo video and how far.
 *   node watch-report.js            all tokens
 *   node watch-report.js sofia-skyline
 * Reads the video_watch table that the `watch` edge function fills from aevon.ca/watch/*.
 */
require('dotenv').config({ quiet: true });
const supabase = require('./lib/supabase');
(async () => {
  let q = supabase.from('video_watch').select('*').order('id', { ascending: true }).limit(5000);
  if (process.argv[2]) q = q.eq('token', process.argv[2]);
  const { data, error } = await q;
  if (error) throw error;
  if (!data.length) return console.log('no rows (the table is empty for that token, or the beacon is broken; check with ?t=selftest)');
  const by = {};
  for (const r of data) {
    const k = r.token;
    by[k] ||= { opens: 0, plays: 0, ended: 0, maxPos: 0, dur: 0, first: r.created_at, last: r.created_at, sessions: new Set() };
    const b = by[k];
    if (r.event === 'open') b.opens++;
    if (r.event === 'play') b.plays++;
    if (r.event === 'ended') b.ended++;
    b.maxPos = Math.max(b.maxPos, r.position); b.dur = Math.max(b.dur, r.duration); b.last = r.created_at;
    if (r.session) b.sessions.add(r.session);
  }
  for (const [k, b] of Object.entries(by)) {
    const pct = b.dur ? Math.round((b.maxPos / b.dur) * 100) : 0;
    console.log(`${k}: opened ${b.opens}x, pressed play ${b.plays}x, reached ${b.maxPos}s of ${b.dur}s (${pct}%)${b.ended ? ', watched to the end' : ''}; ${b.sessions.size} session(s); first ${b.first.slice(0, 16)} last ${b.last.slice(0, 16)}`);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
