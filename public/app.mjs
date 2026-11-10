import { Pactspan } from './core/engine.mjs';
import { importedDocument } from './core/source.mjs';
import { beforeState } from './core/terms.mjs';
import { canonical, fields, identifier, instant, jsonData, object } from './core/data.mjs';
import { DemoCRM, DEMO_TARGET } from './adapters/demo.mjs';
import { CASES } from './data/development.mjs';
import { LocalWorkspace } from './local.mjs';

const STORAGE = 'pactspan-demo-v1';
const $ = id => document.getElementById(id);
let app, crm, clock, selected = null, caseId = 'D01', labels = {}, reads = {}, busy = false, broken = null;
let local = null;

function syncLocal() {
  if (!local) return;
  const value = local.workspace; clock = value.clock; labels = value.metadata.labels; caseId = value.metadata.case_id;
  if (!app.snapshot().candidates[selected]) selected = Object.keys(app.snapshot().candidates)[0] ?? null;
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'class') node.className = value;
    else if (value !== null && value !== undefined && value !== false) {
      if (name in node && !name.startsWith('aria-')) node[name] = value;
      else node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function button(label, action, { primary = false, disabled = false, id = null } = {}) {
  return element('button', { type: 'button', id, 'data-focus-key': label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    class: primary ? 'primary' : '', disabled: busy || disabled || Boolean(local?.workspace.storage_error), onclick: action }, label);
}

function message(value, error = false) {
  const modalError = $('manual-error');
  modalError.hidden = true;
  if (value && error && $('manual-dialog').open) {
    modalError.textContent = value; modalError.hidden = false; return;
  }
  $('message').textContent = value; $('message').hidden = !value;
  $('message').className = 'message' + (error ? ' error' : '');
  $('message').setAttribute('role', error ? 'alert' : 'status');
}

function persist() {
  if (local) { syncLocal(); $('storage-state').textContent = 'Stored in local workspace'; return; }
  if (broken) return;
  const data = { schema_version: 1, domain: app.snapshot(), crm: crm.snapshot(), clock, selected, case_id: caseId, labels };
  try { localStorage.setItem(STORAGE, JSON.stringify(data)); $('storage-state').textContent = 'Stored in this browser'; }
  catch { $('storage-state').textContent = 'Browser storage unavailable · Export to keep changes'; }
}

async function run(action, success = '', { allowRecovery = false } = {}) {
  if (busy) return;
  if (broken && !allowRecovery) { message('Export the original saved JSON or load an example before editing a recovery workspace.', true); return; }
  const active = document.activeElement;
  const focusId = active?.id;
  const focusKey = active?.dataset?.focusKey;
  busy = true; render(); message('');
  try { await action(); persist(); if (success) message(success); }
  catch (error) { message(error.message || 'The action could not complete.', true); }
  finally {
    syncLocal();
    const currentFocus = document.activeElement;
    const restore = currentFocus === document.body || $('detail').contains(currentFocus) || $('candidate-list').contains(currentFocus);
    busy = false; render();
    if (restore) {
      const previous = (focusId && $(focusId)) || (focusKey && document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`));
      const targets = [previous, $('execute-approved'), $('verify-crm'), document.querySelector('#detail h2')];
      const next = targets.find(node => node && !node.disabled && node.getClientRects().length);
      next?.focus({ preventScroll: true });
    }
  }
}

function money(value, currency) {
  if (value === null || value === undefined) return 'Amount unknown';
  return `${currency ?? 'Currency unknown'} ${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(Number(value))}`;
}

function status(candidate, snapshot) { return candidate.version_id ? snapshot.versions[candidate.version_id].status : candidate.supported ? candidate.state : 'unsupported'; }
function stateLabel(value) { return value.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()); }
function details(label, value) { return element('details', {}, element('summary', {}, label), element('pre', {}, JSON.stringify(value, null, 2))); }
function card(title, content, note = null) {
  return element('section', { class: 'card' }, element('div', { class: 'card-head' }, element('h2', {}, title), note ? element('small', {}, note) : null), content);
}
function term(label, value, strong = false) { return element('div', {}, element('dt', {}, label), element('dd', { class: strong ? 'strong' : '' }, value)); }

async function loadCase(id) {
  if (local) { await local.action('loadExample', { id }); reads = {}; selected = null; syncLocal(); return; }
  const value = CASES.find(item => item.id === id); if (!value) throw new Error('Unknown example');
  const anchors = value.sources.map(source => Date.parse(source.meeting_at)).filter(Number.isFinite);
  clock = anchors.length ? new Date(Math.max(...anchors) + 3600_000).toISOString() : '2030-01-08T10:00:00.000Z';
  app = new Pactspan(undefined, { clock: () => clock });
  crm = new DemoCRM({ records: value.crm_initial, clock: () => clock });
  labels = {}; reads = {}; selected = null; caseId = id; broken = null;
  const sources = new Map();
  for (const raw of value.sources) sources.set(raw.id, (await app.importSource(raw)).source.id);
  for (const annotation of value.annotations) {
    const rawTerms = Object.fromEntries(['kind', 'entity_id', 'amount', 'currency', 'owner', 'due', 'conditions'].map(key => [key, annotation[key]]));
    const proposed = await app.propose({ agreement: annotation.agreement, terms: rawTerms, unknown_fields: annotation.unknown_fields,
      evidence: annotation.evidence.map(span => ({ source: sources.get(annotation.source), segment: span.segment, quote: span.quote, start: span.start, end: span.end })) });
    labels[proposed.candidate.id] = { origin: 'Prepared candidate', alias: annotation.id };
    selected ??= proposed.candidate.id;
  }
  $('case-select').value = id;
}

function render() {
  if (!app) return;
  const openIds = [...document.querySelectorAll('details[open][id]')].map(node => node.id);
  const snapshot = app.snapshot();
  $('demo-clock').value = clock.slice(0, 19);
  $('load-example').disabled = busy || Boolean(local?.workspace.storage_error); $('export-workspace').disabled = busy;
  for (const id of ['advance-clock', 'add-manual', 'import-file']) $(id).disabled = busy || Boolean(broken || local?.workspace.storage_error);
  $('candidate-list').replaceChildren(...Object.values(snapshot.candidates).map(candidate => {
    const item = button('', () => { selected = candidate.id; persist(); render(); $(`candidate-${candidate.id}`)?.focus({ preventScroll: true }); }, { id: `candidate-${candidate.id}` });
    item.className = 'candidate'; item.setAttribute('aria-current', String(candidate.id === selected));
    const current = candidate.version_id ? snapshot.versions[candidate.version_id] : null;
    item.append(element('span', { class: 'name' }, `${candidate.terms.entity_id ?? 'Entity unknown'} · ${money(candidate.terms.amount, candidate.terms.currency)}`),
      element('span', { class: 'subline' }, `${current ? `v${current.number} · ` : ''}${stateLabel(status(candidate, snapshot))} · ${labels[candidate.id]?.origin ?? 'Manual candidate'}`));
    return item;
  }));
  const sourceIndex = $('source-index'); sourceIndex.replaceChildren();
  if (local) {
    for (const source of Object.values(snapshot.sources)) sourceIndex.append(element('div', { class: 'source-entry' },
      details(source.title, source), local.workspace.capabilities.extraction ? button('Extract candidates', () => run(async () => {
        const result = await local.action('extract', { source_id: source.id });
        message(result.failure ? result.failure.message : `${result.run.raw_candidate_count} raw model predictions; ${result.run.candidate_ids.length} passed local source and shape validation. Review their meaning before confirmation.`, Boolean(result.failure));
      })) : null));
    for (const entry of local.workspace.metadata.runs.slice().reverse()) sourceIndex.append(element('div', { class: 'source-entry' },
      element('p', { class: 'hint' }, `Extraction: ${entry.status} · ${entry.raw_candidate_count ?? 'Unknown'} raw predictions · ${entry.candidate_ids.length} locally supported`),
      button('Export extraction run', () => run(async () => download(await local.runEvidence(entry.id), entry.id + '.json')))));
  }
  const candidate = snapshot.candidates[selected];
  if (!candidate) {
    $('detail').replaceChildren(element('div', { class: 'blank' }, 'Select a sourced candidate or add one from an imported transcript.'));
    return;
  }
  const current = candidate.version_id ? app.view(candidate.version_id) : null;
  const heading = element('div', { class: 'detail-title' }, element('div', {}, element('h2', { tabIndex: -1 }, money(candidate.terms.amount, candidate.terms.currency)),
    element('p', { class: 'muted' }, `${candidate.terms.entity_id ?? 'Entity unknown'} · ${candidate.terms.kind}${current ? ` · Version ${current.number}` : ''}`)),
  element('span', { class: `status ${status(candidate, snapshot)}` }, stateLabel(status(candidate, snapshot))));
  $('detail').replaceChildren(heading, termsCard(candidate, current, snapshot), crmCard(candidate, current, snapshot), historyCard(candidate, current, snapshot));
  for (const id of openIds) if ($(id)) $(id).open = true;
  if (local?.workspace.storage_error) {
    for (const control of document.querySelectorAll('button,input,select')) control.disabled = true;
    $('export-workspace').disabled = false; message(local.workspace.storage_error, true);
  }
}

function termsCard(candidate, current, snapshot) {
  const value = candidate.terms;
  const grid = element('dl', { class: 'term-grid' }, term('Opportunity', value.entity_id ?? 'Unknown'), term('Owner', value.owner ?? 'Unknown'),
    term('Amount', money(value.amount, value.currency), true), term('Candidate classification', stateLabel(candidate.agreement)),
    term('Deadline wording', value.due?.literal || 'Not stated'), term('Resolved deadline', value.due?.resolved ?? 'Unresolved'));
  const quotes = element('div', { class: 'source-list' }, candidate.evidence.map(span => {
    const source = snapshot.sources[span.source]; const segment = source?.segments[span.segment];
    return element('blockquote', {}, element('p', {}, span.quote), element('footer', {}, `${source?.title ?? 'Unknown source'} · ${span.speaker ?? segment?.speaker ?? 'Unknown speaker'} · ${segment ? Math.floor(segment.start_secs) + 's' : 'Unknown time'}${span.supported ? '' : ' · Unsupported quote'}`),
      source ? details('View source segment', segment) : null);
  }));
  const body = element('div', {}, grid, quotes);
  if (!current) {
    const replacing = Object.values(snapshot.commitments).map(group => snapshot.versions[group.current])
      .find(record => record.terms.kind === value.kind && record.terms.entity_id === value.entity_id && record.target.adapter === (local?.workspace.target.adapter ?? 'demo'));
    const replacement = element('select', { id: 'replace-version' }, element('option', { value: '' }, replacing ? 'Record conflicting terms' : 'New commitment'));
    if (replacing) replacement.append(element('option', { value: replacing.id }, `Explicitly replace version ${replacing.number}`));
    const reason = element('input', { id: 'confirm-reason', placeholder: 'Required for ambiguous agreement', maxLength: 1000 });
    body.append(element('div', { class: 'confirmation-fields' }, element('label', {}, 'Version relationship', replacement), element('label', {}, 'Manager clarification', reason)),
      element('div', { class: 'button-row' }, button('Confirm terms', () => run(async () => {
        await app.confirm(candidate.id, { actor: 'manager', target: DEMO_TARGET, reason: reason.value,
          ...(replacement.value ? { replaces: replacement.value } : {}) });
      }, 'Terms confirmed. A write or receipt still requires the separate checks below.'), { primary: true, disabled: !candidate.supported || value.owner === null || candidate.agreement === 'refused' })));
    if (value.owner === null) body.append(element('p', { class: 'hint' }, 'The owner is unknown. Add a manual clarification as a new sourced candidate before confirming.'));
    if (!candidate.supported) body.append(element('ul', { class: 'guard-list' }, candidate.support_errors.map(reason => element('li', {}, reason))));
  } else {
    if (current.status === 'disputed' && current.dispute_kind === 'terms_conflict') {
      const reason = element('input', { placeholder: 'Reason for selecting these terms', maxLength: 1000 });
      body.append(element('div', { class: 'button-row' }, reason, button('Resolve with this version', () => run(() => app.resolveConflict(current.id, { actor: 'manager', reason: reason.value }), 'Conflict resolved explicitly. Verify the current CRM state before writing.'))));
    }
    value.conditions.forEach((condition, index) => {
      const decision = current.condition_decisions[index]; const reason = element('input', { placeholder: 'Manager attestation and evidence reference', maxLength: 1000 });
      body.append(element('div', { class: 'condition' }, element('p', {}, condition.literal),
        element('p', { class: 'hint' }, decision ? `${decision.satisfied ? 'Satisfied' : 'Not satisfied'} · Manager attestation · ${decision.reason}` : 'Unresolved prerequisite'),
        element('div', { class: 'button-row' }, reason,
          button('Record satisfied', () => run(() => app.decideCondition(current.id, { index, actor: 'manager', satisfied: true, reason: reason.value })), { disabled: current.status === 'superseded' }),
          button('Record not satisfied', () => run(() => app.decideCondition(current.id, { index, actor: 'manager', satisfied: false, reason: reason.value })), { disabled: current.status === 'superseded' }))));
    });
    if (current.execution_reasons.length) body.append(element('ul', { class: 'guard-list' }, current.execution_reasons.map(reason => element('li', {}, reason))));
    body.append(details('Confirmed version and source binding', current));
  }
  return card('Terms and source', body, labels[candidate.id]?.origin ?? 'Manual candidate');
}

function crmCard(candidate, current, snapshot) {
  const wanted = candidate.terms;
  const read = reads[wanted.entity_id] ?? current?.verification?.observed;
  const compare = element('div', { class: 'comparison' },
    element('div', {}, element('span', { class: 'label' }, current ? 'Confirmed expectation' : 'Proposed terms'), element('div', { class: 'value' }, money(wanted.amount, wanted.currency)), element('p', { class: 'meta' }, `${wanted.entity_id ?? 'Unknown entity'}${current ? ` · v${current.number}` : ' · Confirmation required'}`)),
    element('div', {}, element('span', { class: 'label' }, local?.workspace.capabilities.demo === false ? 'Last independent CRM read' : 'Last independent demo read'), element('div', { class: 'value' }, read ? money(read.amount, read.currency) : 'Not checked'), element('p', { class: 'meta' }, read ? `CRM revision ${read.revision} · ${read.observed_at}` : 'Read the current CRM state before approving a change')));
  const check = () => run(async () => {
    const observed = await crm.readOpportunity(wanted.entity_id); reads[wanted.entity_id] = observed;
      if (current) {
      const result = await app.verify(current.id, observed);
      if (result.version?.verification?.observed) reads[wanted.entity_id] = result.version.verification.observed;
      message(result.matched ? 'A matching receipt was recorded for this exact version.' : result.reasons.join('; '));
    }
  });
  const body = element('div', {}, compare, element('div', { class: 'button-row' }, button(current ? 'Verify CRM state' : local?.workspace.capabilities.demo === false ? 'Read CRM' : 'Read Demo CRM', check, { id: 'verify-crm', disabled: wanted.entity_id === null })));
  if (current) {
    const approval = Object.values(snapshot.approvals).find(item => item.version_id === current.id && item.state === 'approved'
      && Date.parse(clock) < Date.parse(item.expires_at));
    const attempt = Object.values(snapshot.attempts).findLast(item => item.version_id === current.id);
    body.append(element('div', { class: 'button-row' }, button('Approve exact change', () => run(async () => {
      if (!read) throw new Error('Read and review the CRM comparison first.');
      const fresh = await crm.readOpportunity(wanted.entity_id);
      if (canonical(beforeState(fresh)) !== canonical(beforeState(read))) {
        reads[wanted.entity_id] = fresh; throw new Error('CRM changed. Review the new comparison before approving.');
      }
      await app.approve(current.id, fresh, { actor: 'manager', expires_at: new Date(Date.parse(clock) + 15 * 60_000).toISOString() });
    }, local?.workspace.capabilities.demo === false ? 'Approved one exact change for fifteen minutes. No write has run yet.' : 'Approved one exact change for fifteen demo minutes. No write has run yet.'), { disabled: current.execution_reasons.length > 0 || !read || Boolean(approval) }),
    button('Execute approved change', () => run(async () => {
      if (!approval) throw new Error('An exact unexpired approval is required.');
      if (local) {
        const result = await local.executeApproval(approval.id);
        message(result.attempt.outcome === 'acknowledged' ? 'The CRM acknowledged the write. Verify separately to obtain a receipt.' : 'Write outcome: ' + (result.attempt.outcome ?? 'pending') + '. Reconcile the prior attempt before another write.'); return;
      }
      const fresh = await crm.readOpportunity(wanted.entity_id);
      const started = await app.beginAttempt(approval.id, fresh);
      if (!started.command) throw new Error('An attempt already exists. Reconcile its outcome instead of writing again.');
      // Browser demo persistence records the one-use attempt before the separate store changes.
      persist();
      try { await crm.updateAmount(started.command); await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' }); }
      catch (error) { await app.finishAttempt(started.attempt.id, { outcome: 'uncertain', reason: error.message }); throw error; }
    }, local ? '' : 'Demo CRM acknowledged the write. Use Verify CRM state to obtain a separate receipt.'), { primary: true, disabled: !approval, id: 'execute-approved' })));
    if (approval) body.append(element('p', { class: 'hint' }, `Approval expires ${approval.expires_at}; ${money(approval.before.amount, approval.before.currency)} → ${money(approval.payload.amount, approval.payload.currency)} on ${approval.before.entity_id}.`));
    if (attempt) body.append(element('p', { class: 'hint' }, `Write outcome: ${attempt.outcome ?? 'pending'}${attempt.reconciliation ? ' · Independently reconciled' : ' · Separate read required'}.`));
    for (const pending of current.unresolved_attempts) body.append(element('div', { class: 'button-row' }, button('Reconcile prior attempt', () => run(async () => {
      const previous = app.snapshot().versions[pending.version_id];
      const fresh = await crm.readOpportunity(previous.terms.entity_id); reads[previous.terms.entity_id] = fresh;
      const result = await app.reconcileAttempt(pending.id, fresh);
      message(result.resolved ? 'Prior outcome reconciled. Fulfillment still requires verification of the current version.' : 'Outcome remains uncertain. A nonmatching read does not authorize another write.');
    }))));
    if (current.fulfillment_receipt) body.append(details('Verification receipt', snapshot.receipts[current.fulfillment_receipt]));
  }
  const external = crm.snapshot().records.find(item => item.entity_id === wanted.entity_id);
  if (external) {
    const amount = element('input', { value: external.amount, inputMode: 'decimal', 'aria-label': 'Demo CRM amount' });
    const currency = element('input', { value: external.currency, maxLength: 3, 'aria-label': 'Demo CRM currency' });
    body.append(element('details', { id: 'external-demo-editor' }, element('summary', {}, 'Edit the separate Demo CRM'), element('p', { class: 'hint' }, 'This changes synthetic external state. It does not update a commitment or create a receipt.'),
      element('div', { class: 'operator-form' }, element('label', {}, 'Amount', amount), element('label', {}, 'Currency', currency),
        button('Apply external edit', () => run(() => crm.operatorChange(wanted.entity_id, { amount: amount.value, currency: currency.value }), 'External demo state changed. Verify again to inspect its effect on the commitment.'))),
      details('External store and effect history', crm.snapshot())));
  }
  return card('CRM check', body, local?.workspace.capabilities.demo === false ? 'EspoCRM · Single-writer sandbox' : 'Synthetic · Separate mutable store');
}

function historyCard(candidate, current, snapshot) {
  const events = snapshot.events.filter(row => row.target === candidate.id || (current && (row.target === current.id
    || row.detail.version_id === current.id || snapshot.attempts[row.target]?.version_id === current.id))).slice().reverse();
  return card('History', element('div', {}, element('ol', { class: 'history' }, events.map(row => element('li', {}, element('p', {}, stateLabel(row.action)), element('time', { dateTime: row.at }, row.at)))), details('Complete workspace history', snapshot)));
}

for (const value of CASES) $('case-select').append(element('option', { value: value.id }, `${value.id} · ${value.title}`));
$('load-example').addEventListener('click', () => {
  if ((Object.keys(app.snapshot().sources).length || broken) && !confirm('Replace this browser demo workspace? Export its history first if you want to keep it.')) return;
  run(() => loadCase($('case-select').value), 'Prepared example loaded. Candidates remain unconfirmed.', { allowRecovery: true });
});
$('advance-clock').addEventListener('click', () => {
  const requested = $('demo-clock').value;
  run(async () => {
  const value = new Date(requested + 'Z').toISOString();
  if (local) { await local.action('setClock', { clock: value }); return; }
  if (Date.parse(value) < Date.parse(clock)) throw new Error('Demo time can only advance. Load an example to start over.');
  clock = value; await app.checkDeadlines();
  });
});
function download(value, filename) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = element('a', { href: url, download: filename }); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export-workspace').addEventListener('click', async () => {
  if (local) { await run(async () => download(await local.export(), 'pactspan-history.json')); return; }
  const value = broken ?? JSON.stringify({ schema_version: 1, domain: app.snapshot(), crm: crm.snapshot(), clock, selected, case_id: caseId, labels }, null, 2);
  download(value, 'pactspan-history.json');
});
$('import-file').addEventListener('change', event => {
  const file = event.target.files?.[0]; if (!file) return;
  event.target.value = '';
  run(async () => {
    if (file.size > 256 * 1024) throw new Error('Transcript exceeds 256 KiB.');
    const text = await file.text(); await app.importSource(importedDocument(text, { title: file.name }));
  }, 'Transcript imported. Add a sourced candidate' + (local?.workspace.capabilities.extraction ? ' or run the configured local extractor.' : '; no extraction model was called.'));
});
document.querySelector('.file-button').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('import-file').click(); }
});

function updateManualSegment() {
  const source = app.snapshot().sources[$('manual-source').value];
  $('manual-segment').replaceChildren(...source.segments.map((segment, index) => element('option', { value: index }, `${Math.floor(segment.start_secs)}s · ${segment.speaker}`)));
  $('manual-quote').value = source.segments[0].text;
}
$('add-manual').addEventListener('click', () => {
  const sources = Object.values(app.snapshot().sources);
  if (!sources.length) { message('Import a transcript first.', true); return; }
  $('manual-source').replaceChildren(...sources.map(source => element('option', { value: source.id }, source.title)));
  $('manual-error').hidden = true; updateManualSegment(); $('manual-dialog').showModal();
});
$('manual-source').addEventListener('change', updateManualSegment);
$('manual-segment').addEventListener('change', () => { $('manual-quote').value = app.snapshot().sources[$('manual-source').value].segments[Number($('manual-segment').value)].text; });
$('manual-cancel').addEventListener('click', () => $('manual-dialog').close());
$('manual-form').addEventListener('submit', event => {
  event.preventDefault();
  const raw = { agreement: $('manual-agreement').value, terms: { kind: 'crm.amount', entity_id: $('manual-entity').value,
    amount: $('manual-amount').value, currency: $('manual-currency').value, owner: $('manual-owner').value || null },
    evidence: [{ source: $('manual-source').value, segment: Number($('manual-segment').value), quote: $('manual-quote').value }] };
  run(async () => { const proposed = await app.propose(raw); selected = proposed.candidate.id; labels[selected] = { origin: 'Manual candidate' }; $('manual-dialog').close(); }, 'Manual candidate retained with its source. Confirmation is separate.');
});

try {
  const session = document.querySelector('meta[name="pactspan-local-session"]')?.content;
  if (session) {
    local = await LocalWorkspace.connect(session); app = local;
    crm = { readOpportunity: id => local.readOpportunity(id), snapshot: () => local.workspace.crm ?? { records: [], ledger: [] },
      operatorChange: (id, values) => local.operatorChange(id, values) };
    syncLocal(); const synthetic = local.workspace.capabilities.demo;
    document.querySelector('.mode').textContent = synthetic ? 'Local synthetic workspace' : 'EspoCRM sandbox';
    document.querySelector('.data-note').textContent = synthetic
      ? 'Prepared examples contain authored candidates. Synthetic CRM state and commitment history are stored separately on this computer.'
      : 'CRM keys stay in the local server. Candidates require manager confirmation; writes require an exact approval and a separate verification read.';
    document.querySelector('.clock-control').hidden = !synthetic; $('advance-clock').hidden = !synthetic;
    document.querySelector('.example-control').hidden = !synthetic; $('load-example').hidden = !synthetic;
    $('storage-state').textContent = 'Stored in local workspace';
  } else {
  const saved = localStorage.getItem(STORAGE);
  if (saved) {
    try {
      const value = JSON.parse(saved);
      jsonData(value); fields(value, ['schema_version', 'domain', 'crm', 'clock', 'selected', 'case_id', 'labels'], 'browser workspace');
      if (value.schema_version !== 1) throw new Error('Unknown browser workspace version');
      clock = instant(value.clock, 'browser workspace clock');
      object(value.labels, 'browser candidate labels'); identifier(value.case_id, 'browser example');
      if (value.selected !== null && !Object.hasOwn(value.domain.candidates, value.selected)) throw new Error('Unknown selected candidate');
      app = await Pactspan.restore(value.domain, { clock: () => clock });
      crm = new DemoCRM({ ...value.crm, clock: () => clock }); selected = value.selected; caseId = value.case_id; labels = value.labels;
      $('case-select').value = caseId;
    } catch {
      broken = saved; clock = '2030-01-08T10:00:00.000Z'; app = new Pactspan(undefined, { clock: () => clock }); crm = new DemoCRM({ clock: () => clock });
      $('storage-state').textContent = 'Recovery required · Export original data';
      message('Saved workspace could not be restored. Export its original JSON before loading another example.', true);
    }
  } else { await loadCase('D01'); persist(); }
  }
} catch {
  if (document.querySelector('meta[name="pactspan-local-session"]')) {
    document.querySelector('.data-note').textContent = 'The local workspace could not be loaded. Preserve its data files and check the local server.';
    for (const control of document.querySelectorAll('button,input,select')) control.disabled = true;
    throw new Error('Local workspace initialization failed');
  }
  await loadCase('D01'); $('storage-state').textContent = 'Browser storage unavailable · Export to keep changes';
}
render();
