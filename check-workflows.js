#!/usr/bin/env node
/**
 * check-workflows.js — audit every workflow for the failures that have actually happened here.
 *
 * WHY THIS EXISTS. Bugs kept being found one at a time, each because a question happened to be
 * asked that exposed it. Four scheduled Cadre runs failed and sent nothing for two days before
 * anyone checked, and the alert email each one sent said the SENDER had failed when the sender
 * had never run. That is not something to find by luck twice.
 *
 * Every check below corresponds to a real incident:
 *
 *   1. A script crashed on import because `new Resend(key)` ran at module load and the step's env
 *      had no Resend key. Requiring a module must never need credentials.
 *   2. A workflow referenced a script by a path that could stop existing.
 *   3. A workflow referenced a secret or variable that was never set, so the step ran with the
 *      value silently empty.
 *   4. Workflows reported "success" while doing nothing, and reported failure by emailing that a
 *      different component had failed.
 *   5. Cron is UTC with no timezone support, so local-hour assumptions desync twice a year.
 *      Covered separately and more deeply by check-schedules.js.
 *
 * Read-only. It runs scripts only in --dry style ways and never sends anything.
 *
 *   node check-workflows.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WF_DIR = '.github/workflows';
const REPO = 'aidancox8/aevon-agent';

let bad = 0, warn = 0;
const fail = (m, d = '') => { bad++; console.log(`FAIL  ${m}${d ? `  ${d}` : ''}`); };
const ok = (m, d = '') => console.log(`ok    ${m}${d ? `  ${d}` : ''}`);
const note = (m, d = '') => { warn++; console.log(`warn  ${m}${d ? `  ${d}` : ''}`); };

const files = fs.readdirSync(WF_DIR).filter(f => f.endsWith('.yml'));

// ── 1. Every script a workflow runs must exist ────────────────────────────────
console.log('\nSCRIPTS REFERENCED BY WORKFLOWS');
const referenced = new Map();          // script -> Set(workflow)
for (const f of files) {
  const y = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
  for (const m of y.matchAll(/node\s+([\w./-]+\.js)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], new Set());
    referenced.get(m[1]).add(f);
  }
}
for (const [script, wfs] of [...referenced].sort()) {
  if (fs.existsSync(script)) ok(script, `(${[...wfs].join(', ')})`);
  else fail(`${script} does not exist`, `referenced by ${[...wfs].join(', ')}`);
}

// ── 2. No script may need credentials merely to be imported ───────────────────
// This is the exact bug that killed four Cadre runs. `new Resend(key)` threw at module load.
console.log('\nIMPORT SAFETY (a require must not need an API key)');
for (const script of [...referenced.keys()].sort()) {
  if (!fs.existsSync(script)) continue;
  const src = fs.readFileSync(script, 'utf8');
  const topLevelResend = /^const \w+ = new Resend\(/m.test(src);
  const topLevelOAuth = /^const \w+ = new google\.auth/m.test(src);
  if (topLevelResend || topLevelOAuth) {
    fail(`${script} builds an API client at module load`, 'any script requiring it needs the key');
  } else ok(script);
}

// ── 3. Secrets and variables a workflow uses must actually be set ─────────────
console.log('\nSECRETS AND VARIABLES');
let known = null;
try {
  const secrets = execSync(`gh secret list --repo ${REPO}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    .split('\n').map(l => l.split('\t')[0]).filter(Boolean);
  const vars = execSync(`gh variable list --repo ${REPO}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    .split('\n').map(l => l.split('\t')[0]).filter(Boolean);
  known = { secrets: new Set(secrets), vars: new Set(vars) };
} catch (e) {
  note('could not reach gh to list secrets, skipping', e.message.split('\n')[0]);
}
if (known) {
  const missingSecrets = new Set(), missingVars = new Set();
  for (const f of files) {
    const y = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    for (const m of y.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      if (!known.secrets.has(m[1])) missingSecrets.add(`${m[1]} (${f})`);
    }
    for (const m of y.matchAll(/vars\.([A-Z0-9_]+)/g)) {
      // A variable with a `|| 'default'` fallback is allowed to be unset.
      const hasDefault = new RegExp(`vars\\.${m[1]}\\s*\\|\\|`).test(y);
      if (!known.vars.has(m[1]) && !hasDefault) missingVars.add(`${m[1]} (${f})`);
    }
  }
  if (missingSecrets.size) fail('secrets referenced but not set', [...missingSecrets].join(', '));
  else ok('every referenced secret exists');
  // An unset variable with no default is usually deliberate (an arming switch), so it is a note.
  if (missingVars.size) note('variables referenced, unset, no default', [...missingVars].join(', '));
  else ok('every referenced variable exists or has a default');
}

// ── 4. Did each workflow's last scheduled run actually succeed? ───────────────
console.log('\nLAST RUN PER WORKFLOW');
for (const f of files) {
  let rows;
  try {
    rows = execSync(`gh run list --workflow=${f} --repo ${REPO} --limit 3`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
  } catch (e) { note(`${f}: could not read run history`); continue; }
  if (!rows.length) { note(`${f}: has never run`); continue; }
  const statuses = rows.map(r => r.split('\t')[1]);
  if (statuses[0] === 'failure') fail(`${f}: last run FAILED`, statuses.join(' '));
  else if (statuses.every(s => s === 'failure')) fail(`${f}: every recent run failed`);
  else if (statuses.includes('failure')) note(`${f}: a recent run failed`, statuses.join(' '));
  else ok(f, statuses.join(' '));
}

console.log(`\n${bad ? `${bad} FAILED` : 'No workflow faults found.'}${warn ? `, ${warn} to look at` : ''}`);
process.exit(bad ? 1 : 0);
