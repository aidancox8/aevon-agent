#!/usr/bin/env node
/**
 * demo/sofia.js, the live-call wrapper around frontdesk/worker.js for the Skyline demo.
 *
 * Fifteen minutes on a screen share is no place for a 140-character command. This keeps one
 * lead's conversation going across turns with the shortest possible line:
 *
 *   node demo/sofia.js "just got orders to JBLM, need a 3br off base"     the lead texts
 *   node demo/sofia.js "Wednesday morning works better"                    the lead answers the offer
 *   node demo/sofia.js C                                                    the lead confirms
 *   node demo/sofia.js --as "Dana Whitfield" "is 918 Idlewood still available"   a second lead
 *   node demo/sofia.js --reset                                              start clean
 *
 * Everything runs the real worker in --simulate (GoHighLevel calls are printed, never made).
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const STATE = path.join(__dirname, '..', 'frontdesk', 'state', 'skyline.json');

if (args.includes('--reset')) {
  try { fs.unlinkSync(STATE); } catch (e) { /* already clean */ }
  console.log('clean slate.');
  process.exit(0);
}

let name = 'Marcus Ellison';
const i = args.indexOf('--as');
if (i > -1) { name = args[i + 1]; args.splice(i, 2); }
const text = args.join(' ').trim();
if (!text) { console.error('usage: node demo/sofia.js [--as "Name"] "<what the lead texts>"'); process.exit(1); }

// One phone per name, so the same lead keeps the same conversation across turns.
const phone = '+1253555' + String([...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 10000).padStart(4, '0');

const r = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'frontdesk', 'worker.js'),
  '--client', 'skyline', '--simulate', text, '--from', phone, '--name', name, '--keep',
], { encoding: 'utf8' });
process.stdout.write((r.stdout || '').split('\n').filter((l) => !/injected env/.test(l)).join('\n'));
if (r.stderr) process.stderr.write(r.stderr.split('\n').filter((l) => !/injected env/.test(l)).join('\n'));
process.exit(r.status || 0);
