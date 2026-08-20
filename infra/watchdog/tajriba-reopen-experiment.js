#!/usr/bin/env node
// tajriba-reopen-experiment.js — re-assert `experimentOpen=true` and
// the current batch's `status=running` on the Tajriba store. Run from
// the delibra-empirica container (no npm deps) every 4 minutes via
// the host cron. Defends against the v1.12.0 partial-freeze: even if
// the freeze somehow toggles experimentOpen back to false, the next
// cron tick will flip it back. The Tajriba session token is read
// from /data/callBackSessionToken (regenerated on every Tajriba
// restart, which is what makes the in-container execution safe).
//
// Usage:  node /opt/delibra/bin/tajriba-reopen-experiment.js
// Exits 0 on success, non-zero on failure (caller decides what to do).
const fs = require('node:fs');

const TOKEN_FILE = '/data/callBackSessionToken';
const TAJRIBA_URL = 'http://127.0.0.1:3000/query';
const TAJRIBA_STORE = '/data/tajriba.json';

async function main() {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) throw new Error('no session token');

  // Build the current state from /data/tajriba.json. We need:
  //   - the global scope id
  //   - the most-recently-created batch scope id that isn't ended
  const lines = fs.readFileSync(TAJRIBA_STORE, 'utf8').split('\n').filter(Boolean);
  const scopes = {};
  const attrs = {};
  for (const ln of lines) {
    let ev;
    try { ev = JSON.parse(ln); } catch (e) { continue; }
    if (ev.kind === 'Scope') {
      scopes[ev.obj.id] = ev.obj;
    } else if (ev.kind === 'Attribute' && ev.obj?.nodeID) {
      let v;
      try { v = JSON.parse(ev.obj.val); } catch { v = ev.obj.val; }
      attrs[ev.obj.nodeID] ||= {};
      attrs[ev.obj.nodeID][ev.obj.key] = v;
    }
  }
  const globalScope = Object.values(scopes).find(s => s.kind === 'global');
  if (!globalScope) throw new Error('no global scope');
  const batchScope = Object.values(scopes)
    .filter(s => s.kind === 'batch')
    .map(s => ({ s, a: attrs[s.id] || {} }))
    .find(({ a }) => a.status !== 'ended' && a.ended !== true && a.endedReason == null)?.s
    || Object.values(scopes).filter(s => s.kind === 'batch').slice(-1)[0];
  if (!batchScope) throw new Error('no batch scope');

  const setAttrs = [
    { key: 'experimentOpen', val: 'true', nodeID: globalScope.id },
  ];
  // Only set status=running if the batch has been initialized but not ended
  const batchAttrs = attrs[batchScope.id] || {};
  if (batchAttrs.initialized && batchAttrs.status !== 'ended' && batchAttrs.ended !== true) {
    setAttrs.push({ key: 'status', val: '"running"', nodeID: batchScope.id, protected: true });
  }

  const body = JSON.stringify({
    query: 'mutation($input: [SetAttributeInput!]!) { setAttributes(input: $input) { attribute { key val } } }',
    variables: { input: setAttrs },
  });

  const r = await fetch(TAJRIBA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });
  const j = await r.json();
  if (j.errors) throw new Error('graphql: ' + JSON.stringify(j.errors));
  console.log(`reopen: experimentOpen=true (global=${globalScope.id.slice(-8)}), batch=${batchScope.id.slice(-8)} status=${batchAttrs.status || 'unknown'} -> running`);
}

main().catch(e => { console.error('reopen-err:', e.message); process.exit(1); });
