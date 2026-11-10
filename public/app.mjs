import { Pactspan, workspaceUsage } from './core/engine.mjs';
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
let manualOriginal = null, manualConditions = [], manualConditionsText = '';

function syncLocal() {
  if (!local) return;
  const value = local.workspace; clock = value.clock; labels = structuredClone(value.metadata.labels); caseId = value.metadata.case_id;
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

function button(label, action, { primary = false, disabled = false, id = null, title = null } = {}) {
  return element('button', { type: 'button', id, title, 'data-focus-key': label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
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
function promiseLabel(candidate) {
  const value = candidate.terms;
  return value.kind === 'crm.amount' ? money(value.amount, value.currency)
    : value.statement || (value.kind === 'proposal.sent' ? 'Send proposal' : 'Other promise');
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
  const capacity = local?.workspace.capacity ?? { domain: workspaceUsage(snapshot) };
  const full = !capacity.domain.within_soft || capacity.frame?.within_growth === false;
  $('capacity-state').hidden = !full;
  $('capacity-state').textContent = full ? 'Workspace growth limit reached. Finish or reconcile the outstanding write, export history and use a fresh workspace.' : '';
  $('demo-clock').value = clock.slice(0, 19);
  $('load-example').disabled = busy || Boolean(local?.workspace.storage_error); $('export-workspace').disabled = false;
  for (const id of ['advance-clock', 'add-manual', 'import-file']) $(id).disabled = busy || Boolean(broken || local?.workspace.storage_error);
  $('candidate-list').replaceChildren(...Object.values(snapshot.candidates).map(candidate => {
    const item = button('', () => { selected = candidate.id; persist(); render(); $(`candidate-${candidate.id}`)?.focus({ preventScroll: true }); }, { id: `candidate-${candidate.id}` });
    item.className = 'candidate'; item.setAttribute('aria-current', String(candidate.id === selected));
    const current = candidate.version_id ? snapshot.versions[candidate.version_id] : null;
    item.append(element('span', { class: 'name' }, `${candidate.terms.entity_id ?? 'Entity unknown'} · ${promiseLabel(candidate)}`),
      element('span', { class: 'subline' }, `${current ? `v${current.number} · ` : ''}${stateLabel(status(candidate, snapshot))} · ${labels[candidate.id]?.origin ?? 'Manual candidate'}`));
    return item;
  }));
  const sourceIndex = $('source-index'); sourceIndex.replaceChildren();
  if (local) {
    for (const source of Object.values(snapshot.sources)) sourceIndex.append(element('div', { class: 'source-entry' },
      details(source.title, source), local.workspace.capabilities.extraction ? button('Extract candidates', () => run(async () => {
        message('Extracting candidates with the local model…');
        const result = await local.action('extract', { source_id: source.id });
        message(result.failure ? result.failure.message : `${result.run.raw_candidate_count} raw model predictions; ${result.run.candidate_ids.length} passed local source and shape validation. Review their meaning before confirmation.`, Boolean(result.failure));
      }), { title: 'The full extraction request is limited to64KiB. The model context can impose a smaller limit.' }) : null));
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
  const heading = element('div', { class: 'detail-title' }, element('div', {}, element('h2', { tabIndex: -1 }, promiseLabel(candidate)),
    element('p', { class: 'muted' }, `${candidate.terms.entity_id ?? 'Entity unknown'} · ${candidate.terms.kind}${current ? ` · Version ${current.number}` : ''}`)),
  element('span', { class: `status ${status(candidate, snapshot)}` }, stateLabel(status(candidate, snapshot))));
  $('detail').replaceChildren(heading, termsCard(candidate, current, snapshot),
    ...(candidate.terms.kind === 'crm.amount' ? [crmCard(candidate, current, snapshot)] : []), historyCard(candidate, current, snapshot));
  for (const id of openIds) if ($(id)) $(id).open = true;
  if (local?.workspace.storage_error) {
    for (const control of document.querySelectorAll('button,input,select')) control.disabled = true;
    $('export-workspace').disabled = false; message(local.workspace.storage_error, true);
  }
}

function termsCard(candidate, current, snapshot) {
  const value = candidate.terms;
  const grid = element('dl', { class: 'term-grid' }, term('Opportunity', value.entity_id ?? 'Unknown'), term('Owner', value.owner ?? 'Unknown'),
    value.kind === 'crm.amount' ? term('Amount', money(value.amount, value.currency), true) : null, term('Candidate classification', stateLabel(candidate.agreement)),
    term('Deadline wording', value.due?.literal || 'Not stated'), term('Resolved deadline', value.due?.resolved ?? 'Unresolved'));
  const quotes = element('div', { class: 'source-list' }, candidate.evidence.map(span => {
    const source = snapshot.sources[span.source]; const segment = source?.segments[span.segment];
    return element('blockquote', {}, element('p', {}, span.quote), element('footer', {}, `${source?.title ?? 'Unknown source'} · ${span.speaker ?? segment?.speaker ?? 'Unknown speaker'} · ${segment ? Math.floor(segment.start_secs) + 's' : 'Unknown time'}${span.supported ? '' : ' · Unsupported quote'}`),
      source ? details('View source segment', segment) : null);
  }));
  const body = element('div', {}, grid, quotes);
  const provenance = labels[candidate.id];
  body.append(element('div', { class: 'button-row' }, button('Create corrected candidate', () => openManual(candidate))));
  if (provenance?.corrects) body.append(details('Correction decision', provenance), button('View original candidate', () => {
    selected = provenance.corrects; persist(); render(); document.querySelector('#detail h2')?.focus({ preventScroll: true });
  }));
  if (!current) {
    const compatible = Object.values(snapshot.commitments).map(group => snapshot.versions[group.current])
      .filter(record => record.terms.kind === value.kind && record.terms.entity_id === value.entity_id && record.target.adapter === (local?.workspace.target.adapter ?? 'demo'));
    const replacement = element('select', { id: 'replace-version' }, element('option', { value: '' },
      value.kind === 'crm.amount' && compatible.length ? 'Record conflicting terms' : 'New independent commitment'));
    for (const record of compatible) {
      const label = value.kind === 'crm.amount' ? `version ${record.number}` : `${record.terms.statement || record.terms.kind} · v${record.number}`;
      replacement.append(element('option', { value: 'replace:' + record.id }, 'Explicitly replace ' + label));
      if (value.kind !== 'crm.amount') replacement.append(element('option', { value: 'relate:' + record.id }, 'Record conflict with ' + label));
    }
    const reason = element('input', { id: 'confirm-reason', value: provenance?.corrects ? provenance.reason : '',
      placeholder: 'Required for ambiguous agreement or correction', maxLength: 1000 });
    body.append(element('div', { class: 'confirmation-fields' }, element('label', {}, 'Version relationship', replacement), element('label', {}, 'Manager clarification', reason)),
      element('div', { class: 'button-row' }, button('Confirm terms', () => run(async () => {
        const relationship = replacement.value.startsWith('replace:') ? { replaces: replacement.value.slice(8) }
          : replacement.value.startsWith('relate:') ? { related_to: replacement.value.slice(7) } : {};
        if (provenance?.corrects && reason.value.trim().length < 3) throw new Error('Confirming a correction requires a reason of at least three characters.');
        await app.confirm(candidate.id, { actor: 'manager', target: DEMO_TARGET, reason: reason.value, ...relationship });
      }, 'Terms confirmed. A write or receipt still requires the separate checks below.'), { primary: true, disabled: !candidate.supported || value.owner === null || candidate.agreement === 'refused' })));
    if (value.owner === null) body.append(element('p', { class: 'hint' }, 'The owner is unknown. Create a corrected candidate before confirming.'));
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
    for (const pending of current.unresolved_attempts.filter(item => item.outcome === 'uncertain' || item.outcome === null)) {
      const stopped = element('input', { type: 'checkbox' });
      const reason = element('textarea', { rows: 2, maxLength: 1000 });
      const close = button('Record operator closure', () => run(async () => {
        const options = { actor: 'operator', reason: reason.value, writer_quiesced: stopped.checked };
        if (local) await local.closeUncertainAttempt(pending.id, options);
        else {
          const previous = app.snapshot().versions[pending.version_id];
          await app.closeUncertainAttempt(pending.id, await crm.readOpportunity(previous.terms.entity_id), options);
        }
      }, 'Operator closure recorded with a fresh read. This is an attestation, not proof of fulfillment.'), { disabled: true });
      stopped.addEventListener('change', () => { close.disabled = busy || !stopped.checked; });
      body.append(element('details', {}, element('summary', {}, 'Operator recovery for an uncertain request'),
        element('p', { class: 'hint' }, 'First stop or drain the original writer request in the sandbox. A newer CRM revision alone does not prove it cannot apply later.'),
        element('label', { class: 'checkbox-row' }, stopped, 'I verified that the original request can no longer apply.'),
        element('label', {}, 'How was the request stopped or drained?', reason), close));
    }
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
  if (local) {
    try { download(await local.export(), 'pactspan-history.json'); }
    catch (error) { message(error.message || 'History could not be exported.', true); }
    return;
  }
  const value = broken ?? JSON.stringify({ schema_version: 1, domain: app.snapshot(), crm: crm.snapshot(), clock, selected, case_id: caseId, labels }, null, 2);
  download(value, 'pactspan-history.json');
});
$('import-file').addEventListener('change', event => {
  const file = event.target.files?.[0]; if (!file) return;
  event.target.value = '';
  run(async () => {
    if (file.size > 256 * 1024) throw new Error('Transcript exceeds 256 KiB.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('Transcript must be valid UTF-8.'); }
    await app.importSource(importedDocument(text, { title: file.name }));
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
function manualKind() { $('manual-statement').required = $('manual-kind').value !== 'crm.amount'; }
function originalCitations(candidate) {
  return candidate.evidence.map(span => Object.fromEntries(['source', 'segment', 'quote', 'start', 'end']
    .filter(key => Object.hasOwn(span, key)).map(key => [key, span[key]])));
}
function openManual(candidate = null) {
  if (busy || broken || local?.workspace.storage_error) return;
  const sources = Object.values(app.snapshot().sources);
  if (!sources.length) { message('Import a transcript first.', true); return; }
  $('manual-form').reset(); manualOriginal = candidate ? structuredClone(candidate) : null;
  $('manual-source').replaceChildren(...sources.map(source => element('option', { value: source.id }, source.title)));
  updateManualSegment();
  $('manual-source-fields').hidden = Boolean(candidate);
  for (const id of ['manual-source', 'manual-segment', 'manual-quote']) $(id).disabled = Boolean(candidate);
  $('manual-citations').hidden = !candidate;
  $('manual-citations').replaceChildren(...(candidate ? candidate.evidence.map(span => element('blockquote', {},
    element('p', {}, span.quote), element('footer', {}, `${sources.find(source => source.id === span.source)?.title ?? 'Unknown source'} · Segment ${span.segment} · ${span.start ?? '?'}–${span.end ?? '?'}`))) : []));
  $('manual-title').textContent = candidate ? 'Correct candidate' : 'Sourced candidate';
  $('manual-submit').textContent = candidate ? 'Add corrected candidate' : 'Add candidate';
  $('manual-reason-field').hidden = !candidate; $('manual-reason').required = Boolean(candidate);
  $('manual-kind').value = candidate?.terms.kind ?? 'crm.amount';
  $('manual-statement').value = candidate?.terms.statement ?? '';
  $('manual-entity').value = candidate ? candidate.terms.entity_id ?? '' : 'O1';
  $('manual-owner').value = candidate?.terms.owner ?? '';
  $('manual-amount').value = candidate?.terms.amount ?? '';
  $('manual-currency').value = candidate ? candidate.terms.currency ?? '' : 'USD';
  $('manual-agreement').value = candidate?.agreement ?? 'proposed';
  $('manual-unknowns').value = candidate?.unknown_fields.join('\n') ?? '';
  $('manual-due-literal').value = candidate?.terms.due?.literal ?? '';
  $('manual-due-resolved').value = candidate?.terms.due?.resolved ?? '';
  $('manual-due-precision').value = candidate?.terms.due?.precision ?? 'unknown';
  $('manual-due-zone').value = candidate?.terms.due?.zone ?? '';
  manualConditions = candidate?.terms.conditions.map(condition => ({ literal: condition.literal })) ?? [];
  manualConditionsText = manualConditions.map(condition => condition.literal).join('\n');
  $('manual-conditions').value = manualConditionsText;
  $('manual-advanced').open = false; manualKind();
  $('manual-error').hidden = true; $('manual-dialog').showModal();
}
$('add-manual').addEventListener('click', () => openManual());
$('manual-kind').addEventListener('change', manualKind);
$('manual-source').addEventListener('change', updateManualSegment);
$('manual-segment').addEventListener('change', () => { $('manual-quote').value = app.snapshot().sources[$('manual-source').value].segments[Number($('manual-segment').value)].text; });
$('manual-cancel').addEventListener('click', () => $('manual-dialog').close());
$('manual-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const original = manualOriginal;
    const literal = $('manual-due-literal').value, resolved = $('manual-due-resolved').value.trim() || null;
    const precision = $('manual-due-precision').value, zone = $('manual-due-zone').value.trim() || null;
    const due = literal || resolved || zone || precision !== 'unknown' ? { literal, resolved, precision, zone } : null;
    const conditions = $('manual-conditions').value === manualConditionsText ? structuredClone(manualConditions)
      : $('manual-conditions').value.split(/\r?\n/).filter(line => line.trim()).map(literal => ({ literal }));
    const snapshot = app.snapshot();
    const sourceIds = original ? original.evidence.map(span => span.source) : [$('manual-source').value];
    const sources = [...new Set(sourceIds)].map(id => snapshot.sources[id]).filter(Boolean);
    const inSource = text => sources.some(source => source.segments.some(segment => segment.text.includes(text)));
    if (literal && !inSource(literal)) throw new Error('Deadline wording must be an exact source phrase.');
    if (conditions.some(condition => !inSource(condition.literal))) throw new Error('Each prerequisite must be an exact source phrase.');
    const correction = original ? { corrects: original.id, reason: $('manual-reason').value.trim() } : {};
    if (original && correction.reason.length < 3) throw new Error('A correction reason needs at least three characters.');
    const raw = { agreement: $('manual-agreement').value, terms: { kind: $('manual-kind').value,
      statement: $('manual-statement').value, entity_id: $('manual-entity').value.trim() || null,
      amount: $('manual-amount').value.trim() || null, currency: $('manual-currency').value.trim() || null,
      owner: $('manual-owner').value.trim() || null, due, conditions },
      unknown_fields: $('manual-unknowns').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
      evidence: original ? originalCitations(original) : [{ source: $('manual-source').value,
        segment: Number($('manual-segment').value), quote: $('manual-quote').value }] };
    const proposed = local ? await local.propose(raw, correction) : await app.propose(raw);
    selected = proposed.candidate.id;
    if (!local) labels[selected] ??= original ? { origin: 'Manual correction', ...correction, actor: 'manager' } : { origin: 'Manual candidate' };
    $('manual-dialog').close();
    message(proposed.duplicate ? 'Matching candidate already exists. Its first origin and confirmation status were retained.'
      : original ? 'Corrected candidate retained. Review it and confirm separately.' : 'Manual candidate retained with its source. Confirmation is separate.');
  });
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
