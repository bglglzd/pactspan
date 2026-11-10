import { Pactspan } from './core/engine.mjs';
import { beforeState } from './core/terms.mjs';

// Browser commands contain decisions and identifiers, never a trusted receipt or raw CRM PUT.
export class LocalWorkspace {
  #token; #workspace; #engine;
  constructor(token) { this.#token = token; }
  static async connect(token) { const local = new LocalWorkspace(token); await local.refresh(); return local; }
  get workspace() { return structuredClone(this.#workspace); }
  async #request(route, options = {}) {
    const response = await fetch(route, { ...options, headers: { 'X-Pactspan-Token': this.#token, ...(options.headers ?? {}) }, cache: 'no-store', redirect: 'error' });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Local request failed'); return value;
  }
  async #replace(workspace) {
    this.#engine = await Pactspan.restore(workspace.domain, { clock: () => workspace.clock }); this.#workspace = workspace;
  }
  async refresh() { await this.#replace(await this.#request('/api/workspace')); }
  snapshot() { return this.#engine.snapshot(); }
  view(id) { return this.#engine.view(id); }
  async action(action, args = {}) {
    try {
      const value = await this.#request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) });
      await this.#replace(value.workspace); return value.result;
    } catch (error) { await this.refresh().catch(() => {}); throw error; }
  }
  importSource(document) { return this.action('importSource', { document }); }
  propose(candidate) { return this.action('propose', { candidate }); }
  confirm(candidate_id, { target: _target, ...options }) { return this.action('confirm', { candidate_id, options }); }
  decideCondition(version_id, options) { return this.action('decideCondition', { version_id, options }); }
  resolveConflict(version_id, options) { return this.action('resolveConflict', { version_id, options }); }
  approve(version_id, reviewed, options) { return this.action('approve', { version_id, reviewed: beforeState(reviewed), options }); }
  verify(version_id) { return this.action('verify', { version_id }); }
  reconcileAttempt(attempt_id) { return this.action('reconcile', { attempt_id }); }
  checkDeadlines() { return this.action('checkDeadlines'); }
  executeApproval(approval_id) { return this.action('execute', { approval_id }); }
  readOpportunity(entity_id) { return this.action('read', { entity_id }); }
  operatorChange(entity_id, values) { return this.action('operatorChange', { entity_id, values }); }
  async export() { return this.#request('/api/export'); }
  async runEvidence(id) { return this.#request('/api/runs/' + encodeURIComponent(id)); }
}
