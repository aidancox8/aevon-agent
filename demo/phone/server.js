#!/usr/bin/env node
/**
 * demo/phone/server.js, the Skyline demo as two phones instead of a terminal.
 *
 * The terminal run is honest and complete and impresses nobody who sells houses. This page shows
 * what Sofia would actually see: the lead's text thread on one phone, her inbox on the other with
 * the draft waiting for her tap. Every reply still comes from frontdesk/worker.js in simulate
 * mode via demo/sofia.js; this file only parses that output into a screen. Nothing here can send.
 *
 *   node demo/phone/server.js          then open http://localhost:4173
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PORT = 4173;
const SOFIA = path.join(__dirname, '..', 'sofia.js');

function run(args) {
  const r = spawnSync(process.execPath, [SOFIA, ...args], { encoding: 'utf8', timeout: 90000 });
  if (r.error && r.error.code === 'ETIMEDOUT') return (r.stdout || '') + '\n  worker: [timeout] the models did not answer in 90 seconds\n';
  return (r.stdout || '') + (r.stderr || '');
}

/** Turn the worker's log into the events the screen draws. */
function parse(out) {
  const ev = { verdict: null, reason: '', known: [], missing: [], tags: [], note: false, draft: null, appointment: null, confirmation: null, skipped: null, log: out };
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s{2}\S[^:]*: \[([^\]]+)\] ?(.*)$/))) { ev.verdict = m[1]; ev.reason = m[2].trim(); continue; }
    if ((m = l.match(/^\s+known: (.*)$/))) { ev.known = m[1].split(' | ').map((s) => s.trim()); continue; }
    if ((m = l.match(/^\s+still needed: (.*)$/))) { ev.missing = m[1].split(' | ').map((s) => s.trim()); continue; }
    if ((m = l.match(/^\s+held \d+ slot\(s\); skipped (.*)$/))) { ev.skipped = m[1].trim(); continue; }
    if ((m = l.match(/^\s+\S[^:]*: (asked for .*|confirmed slot \d)$/))) { ev.verdict = ev.verdict || 'reply'; ev.reason = m[1]; continue; }
    if ((m = l.match(/^\s+would: add note/))) { ev.note = true; continue; }
    if ((m = l.match(/^\s+would: (?:add tags|tag \w+(?: \w+)?) (\{.*\})$/))) { try { ev.tags.push(...JSON.parse(m[1]).tags); } catch (e) { /* ignore */ } continue; }
    if ((m = l.match(/^\s+would: create appointment (\{.*\})$/))) { try { ev.appointment = JSON.parse(m[1]); } catch (e) { /* ignore */ } continue; }
    if ((m = l.match(/^\s+would: send confirmation (\{.*\})$/))) { try { ev.confirmation = JSON.parse(m[1]).message; } catch (e) { /* ignore */ } continue; }
    if (/^\s+draft:\s*$/.test(l)) {
      const body = [];
      // The worker prints every draft line, blank ones included, behind seven spaces.
      for (let j = i + 1; j < lines.length && lines[j].startsWith('       '); j++) { body.push(lines[j].slice(7)); i = j; }
      ev.draft = body.join('\n').trim();
    }
  }
  return ev;
}

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (req.method === 'POST' && req.url === '/reset') { run(['--reset']); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && req.url === '/text') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p; try { p = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const text = String(p.text || '').trim(); const name = String(p.name || 'Marcus Ellison').trim();
      if (!text) return json(res, 400, { error: 'empty' });
      const out = run(['--as', name, text]);
      return json(res, 200, parse(out));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Skyline phones at http://localhost:${PORT}  (Ctrl+C to stop)`));
