import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pactspan, workspaceUsage, workspaceSettlementEligible } from '../core/engine.mjs';
import { beforeState, adapterTarget } from '../core/terms.mjs';
import { canonical, fields, identifier, instant, requireValue, object, list } from '../core/data.mjs';
import { extractCandidates, extractionConfig } from '../adapters/extract.mjs';
import { DEMO_TARGET } from '../adapters/demo.mjs';
import { WorkspaceStore } from './store.mjs';
import { DiskDemoCRM } from './demo-crm.mjs';
import { privateDirectory, privateRead, privateWrite } from './files.mjs';

export class WorkspaceController {
  #store; #app; #metadata; #crm; #target; #extraction; #root; #runs; #queue = Promise.resolve(); #clock; #storageFault = false; #revision = 0;

  static async open({ directory, crm = null, target = DEMO_TARGET, extraction = null, clock = null }) {
    const instance = new WorkspaceController();
    instance.#target = adapterTarget(target); instance.#extraction = extraction;
    if (extraction) extractionConfig(extraction);
    instance.#root = await privateDirectory(directory);
    instance.#store = await WorkspaceStore.open(instance.#root);
    try {
      const saved = await instance.#store.load();
      if (saved) instance.#revision = JSON.parse(await instance.#store.raw()).revision;
      instance.#metadata = saved?.metadata ?? { schema_version: 1, target: instance.#target, labels: {}, runs: [], case_id: null, demo_clock: '2030-01-08T10:00:00.000Z' };
      fields(instance.#metadata, ['schema_version', 'target', 'labels', 'runs', 'case_id', 'demo_clock'], 'Local metadata');
      requireValue(instance.#metadata.schema_version === 1 && canonical(instance.#metadata.target) === canonical(instance.#target), 'Workspace CRM target differs from its saved configuration');
      object(instance.#metadata.labels, 'Saved candidate labels'); list(instance.#metadata.runs, 'Saved extraction runs', 200);
      instant(instance.#metadata.demo_clock, 'Saved demo clock');
      instance.#clock = clock ?? (() => instance.#target.adapter === 'demo' ? instance.#metadata.demo_clock : new Date().toISOString());
      instance.#app = saved ? await Pactspan.restore(saved.domain, { clock: instance.#clock }) : new Pactspan(undefined, { clock: instance.#clock });
      instance.#crm = crm ?? (instance.#target.adapter === 'demo' ? await DiskDemoCRM.open(instance.#root, { clock: instance.#clock }) : null);
      requireValue(instance.#crm && typeof instance.#crm.readOpportunity === 'function' && typeof instance.#crm.updateAmount === 'function', 'A configured CRM adapter is required');
      instance.#runs = await privateDirectory(path.join(instance.#root, 'runs'));
      if (!saved) await instance.#commit(instance.#app);
      return instance;
    } catch (error) { await instance.#store.close(); throw error; }
  }

  snapshot() {
    return { domain: this.#app.snapshot(), metadata: structuredClone(this.#metadata), clock: this.#clock(),
      target: structuredClone(this.#target), capabilities: { demo: this.#target.adapter === 'demo', extraction: Boolean(this.#extraction) },
      storage_error: this.#storageFault ? 'Local storage did not acknowledge the commit. Preserve the workspace and restart before editing' : null,
      capacity: { domain: workspaceUsage(this.#app.snapshot()), frame: this.#frameUsage(this.#app.snapshot(), this.#metadata) },
      crm: this.#target.adapter === 'demo' ? this.#crm.snapshot() : null };
  }
  async close() { await this.#queue; await this.#store.close(); }
  async export() {
    return JSON.stringify({ workspace: JSON.parse(await this.#store.raw()),
      external_synthetic_crm: this.#target.adapter === 'demo' ? this.#crm.snapshot() : null }, null, 2);
  }
  async runEvidence(id) { identifier(id, 'Extraction run ID'); return privateRead(this.#runs, id + '.json'); }

  #serial(callback) {
    const result = this.#queue.then(callback); this.#queue = result.catch(() => {}); return result;
  }
  async #draft() { return Pactspan.restore(this.#app.snapshot(), { clock: this.#clock }); }
  #frameUsage(domain, metadata, revision = this.#revision) {
    const bytes = Buffer.byteLength(JSON.stringify({ schema_version: 1, revision, domain, metadata, checksum: '0'.repeat(64) })) + 1;
    return { bytes, growth_limit: 1.5 * 1024 * 1024, hard_limit: 2 * 1024 * 1024, within_growth: bytes <= 1.5 * 1024 * 1024 };
  }
  async #commit(app, metadata = this.#metadata, settlement = {}) {
    const before = this.#app.snapshot(); const after = app.snapshot();
    const frame = this.#frameUsage(after, metadata, this.#revision + 1);
    requireValue(frame.within_growth || frame.bytes <= this.#frameUsage(before, this.#metadata).bytes
      || workspaceSettlementEligible(before, settlement),
    'Workspace storage growth limit reached. Settle the outstanding write, export history and open a fresh data directory');
    try { this.#revision = await this.#store.save({ domain: after, metadata }); }
    catch (error) {
      if (['WORKSPACE_INPUT', 'WORKSPACE_TOO_LARGE'].includes(error.code)) throw error;
      // Rename may have succeeded before a later fsync failed. Never continue
      // from the old in-memory state or retry an external action in this process.
      this.#storageFault = true;
      try {
        const saved = await this.#store.load();
        if (saved) { this.#app = await Pactspan.restore(saved.domain, { clock: this.#clock }); this.#metadata = saved.metadata;
          this.#revision = JSON.parse(await this.#store.raw()).revision; }
      } catch { /* Preserve the file; startup will validate it before future edits. */ }
      throw error;
    }
    this.#app = app; this.#metadata = structuredClone(metadata);
  }
  #record(versionId) {
    identifier(versionId, 'Version ID'); const version = this.#app.snapshot().versions[versionId];
    requireValue(version && canonical(version.target) === canonical(this.#target), 'Version does not belong to the configured CRM'); return version;
  }

  dispatch(action, args = {}) { return this.#serial(() => this.#dispatch(action, args)); }
  async #dispatch(action, args) {
    requireValue(!this.#storageFault, 'Local storage did not acknowledge a commit. Preserve the workspace and restart before editing');
    identifier(action, 'Action');
    if (action === 'read') {
      fields(args, ['entity_id'], 'read'); return this.#crm.readOpportunity(identifier(args.entity_id, 'Entity ID'));
    }
    if (action === 'execute') return this.#execute(args);
    if (action === 'extract') return this.#extract(args);
    if (action === 'loadExample') return this.#loadExample(args);
    if (action === 'operatorChange') {
      requireValue(this.#target.adapter === 'demo', 'External edits are available only in the synthetic CRM');
      fields(args, ['entity_id', 'values'], 'operator change'); return this.#crm.operatorChange(args.entity_id, args.values);
    }
    const draft = await this.#draft(); let result; let metadata = structuredClone(this.#metadata); let settlement = {};
    switch (action) {
      case 'importSource':
        fields(args, ['document'], action); result = await draft.importSource(args.document); break;
      case 'propose':
        fields(args, ['candidate'], action); result = await draft.propose(args.candidate);
        metadata.labels[result.candidate.id] ??= { origin: 'Manual candidate' }; break;
      case 'confirm':
        fields(args, ['candidate_id', 'options'], action);
        fields(args.options, ['actor', 'reason', 'replaces', 'related_to', 'resolved_unknowns'], 'Confirmation options');
        result = await draft.confirm(args.candidate_id, { ...args.options, target: this.#target }); break;
      case 'decideCondition':
        fields(args, ['version_id', 'options'], action); this.#record(args.version_id);
        result = await draft.decideCondition(args.version_id, args.options); break;
      case 'resolveConflict':
        fields(args, ['version_id', 'options'], action); this.#record(args.version_id);
        result = await draft.resolveConflict(args.version_id, args.options); break;
      case 'approve': {
        fields(args, ['version_id', 'reviewed', 'options'], action); const version = this.#record(args.version_id);
        fields(args.reviewed, ['adapter', 'mode', 'origin', 'entity_id', 'amount', 'currency', 'revision'], 'Reviewed before state');
        const fresh = await this.#crm.readOpportunity(version.terms.entity_id);
        requireValue(canonical(beforeState(fresh)) === canonical(args.reviewed), 'CRM changed. Read and review the new comparison before approving');
        result = await draft.approve(args.version_id, fresh, args.options); break;
      }
      case 'verify': {
        fields(args, ['version_id'], action); const version = this.#record(args.version_id);
        settlement = { verifyVersion: version.id, verifyAttempt: null };
        result = await draft.verify(args.version_id, await this.#crm.readOpportunity(version.terms.entity_id)); break;
      }
      case 'reconcile': {
        fields(args, ['attempt_id'], action); const attempt = this.#app.snapshot().attempts[identifier(args.attempt_id, 'Attempt ID')];
        requireValue(attempt, 'Unknown attempt'); const version = this.#record(attempt.version_id);
        settlement = { settleAttempt: attempt.id };
        result = await draft.reconcileAttempt(attempt.id, await this.#crm.readOpportunity(version.terms.entity_id)); break;
      }
      case 'closeAttempt': {
        fields(args, ['attempt_id', 'options'], action); const attempt = this.#app.snapshot().attempts[identifier(args.attempt_id, 'Attempt ID')];
        requireValue(attempt, 'Unknown attempt'); const version = this.#record(attempt.version_id);
        settlement = { settleAttempt: attempt.id };
        result = await draft.closeUncertainAttempt(attempt.id, await this.#crm.readOpportunity(version.terms.entity_id), args.options); break;
      }
      case 'checkDeadlines': fields(args, [], action); result = await draft.checkDeadlines(); break;
      case 'setClock': {
        requireValue(this.#target.adapter === 'demo', 'The real CRM uses system time'); fields(args, ['clock'], action);
        const next = instant(args.clock, 'Demo clock'); requireValue(Date.parse(next) >= Date.parse(this.#clock()), 'Demo time can only advance');
        metadata.demo_clock = next;
        const advanced = await Pactspan.restore(this.#app.snapshot(), { clock: () => next }); result = await advanced.checkDeadlines();
        await this.#commit(advanced, metadata); return result;
      }
      default: requireValue(false, 'Unsupported local action');
    }
    await this.#commit(draft, metadata, settlement); return result;
  }

  async #execute(args) {
    fields(args, ['approval_id'], 'execute'); const id = identifier(args.approval_id, 'Approval ID');
    const snapshot = this.#app.snapshot(); const approval = snapshot.approvals[id]; requireValue(approval, 'Unknown approval');
    const version = this.#record(approval.version_id);
    const draft = await this.#draft();
    const started = await draft.beginAttempt(id, await this.#crm.readOpportunity(version.terms.entity_id));
    // No external write happens before a durable consumed approval and pending attempt.
    await this.#commit(draft);
    if (!started.command) return { attempt: started.attempt, reconcile: true, requires_verification: true };
    let outcome = 'acknowledged'; let reason = '';
    try { await this.#crm.updateAmount(started.command); }
    catch (error) {
      // A preflight refusal has no PUT; every ambiguous transport outcome stays uncertain.
      outcome = error.write_sent === false || ['conflict', 'denied', 'invalid_input', 'configuration', 'busy', 'single_writer_required'].includes(error.code) ? 'rejected' : 'uncertain';
      reason = outcome === 'rejected' ? 'CRM refused the guarded request before an acknowledged write' : 'The write outcome is uncertain; use a fresh read to reconcile';
    }
    const completed = await this.#draft(); const attempt = await completed.finishAttempt(started.attempt.id, { outcome, reason });
    await this.#commit(completed, this.#metadata, { settleAttempt: started.attempt.id });
    return { attempt, requires_verification: true, reconcile: outcome === 'uncertain' };
  }

  async #extract(args) {
    fields(args, ['source_id'], 'extract'); requireValue(this.#extraction, 'A local extraction model is not configured');
    requireValue(this.#metadata.runs.length < 200, 'Extraction history has reached 200 runs. Export it and use a new workspace before extracting again');
    requireValue(workspaceUsage(this.#app.snapshot()).within_soft
      && this.#frameUsage(this.#app.snapshot(), this.#metadata).bytes + 10_000 <= 1.5 * 1024 * 1024,
    'Workspace growth limit reached. Export history and open a fresh data directory before another extraction');
    const source = this.#app.snapshot().sources[identifier(args.source_id, 'Source ID')]; requireValue(source, 'Unknown source');
    const id = 'run_' + randomUUID(); let result; let failure = null;
    try { result = await extractCandidates(source, this.#extraction); }
    catch (error) { failure = { code: error.code ?? 'extraction_failed', message: 'Local extraction failed; inspect the retained run evidence' }; result = error.evidence ?? null; }
    await privateWrite(this.#runs, id + '.json', { schema_version: 1, id, source_id: source.id, at: this.#clock(), failure, result }, { exclusive: true });
    let metadata = structuredClone(this.#metadata); let draft = await this.#draft(); let candidateIds = [];
    if (!failure) try { for (const predicted of result.candidates) {
      if (!predicted.supported || !predicted.terms || !predicted.evidence) continue;
      const proposed = await draft.propose({ agreement: predicted.agreement, terms: predicted.terms, unknown_fields: predicted.unknown_fields,
        evidence: predicted.evidence.map(({ source, segment, quote, start, end }) => ({ source, segment, quote, start, end })) });
      metadata.labels[proposed.candidate.id] ??= { origin: 'Model candidate', run_id: id, raw_index: predicted.raw_index };
      candidateIds.push(proposed.candidate.id);
    }
      requireValue(this.#frameUsage(draft.snapshot(), metadata, this.#revision + 1).bytes + 5000 <= 1.5 * 1024 * 1024, 'Insufficient capacity for extracted candidates');
    } catch {
      draft = await this.#draft(); metadata = structuredClone(this.#metadata); candidateIds = [];
      failure = { code: 'ingestion_refused', message: 'Model output was retained, but candidates could not fit this workspace. Export the run and use a fresh data directory' };
    }
    metadata.runs.push({ id, source_id: source.id, status: failure?.code ?? result.status, raw_candidate_count: result?.raw_candidate_count ?? null,
      candidate_ids: candidateIds, ...(failure?.code === 'ingestion_refused' ? { ingestion_failure: failure } : {}) });
    await this.#commit(draft, metadata);
    return { run: metadata.runs.at(-1), failure };
  }

  async #loadExample(args) {
    requireValue(this.#target.adapter === 'demo', 'Prepared examples are available only in synthetic mode');
    fields(args, ['id'], 'load example'); requireValue(/^D\d\d$/.test(args.id), 'Unknown example');
    const value = JSON.parse(await readFile(new URL(`../../examples/development/${args.id}.json`, import.meta.url), 'utf8'));
    const anchors = value.sources.map(source => Date.parse(source.meeting_at)).filter(Number.isFinite);
    const metadata = { schema_version: 1, target: this.#target, labels: {}, runs: [], case_id: value.id,
      demo_clock: anchors.length ? new Date(Math.max(...anchors) + 3600_000).toISOString() : '2030-01-08T10:00:00.000Z' };
    const draft = new Pactspan(undefined, { clock: () => metadata.demo_clock }); const sources = new Map();
    for (const source of value.sources) sources.set(source.id, (await draft.importSource(source)).source.id);
    for (const annotation of value.annotations) {
      const rawTerms = Object.fromEntries(['kind', 'entity_id', 'amount', 'currency', 'owner', 'due', 'conditions'].map(key => [key, annotation[key]]));
      const result = await draft.propose({ agreement: annotation.agreement, terms: rawTerms, unknown_fields: annotation.unknown_fields,
        evidence: annotation.evidence.map(span => ({ source: sources.get(annotation.source), segment: span.segment, quote: span.quote, start: span.start, end: span.end })) });
      metadata.labels[result.candidate.id] = { origin: 'Prepared candidate', alias: annotation.id };
    }
    // Reset is explicit and synthetic-only; these are two separate stores, not a distributed transaction.
    await this.#crm.reset(value.crm_initial); await this.#commit(draft, metadata); return { case_id: value.id };
  }
}
