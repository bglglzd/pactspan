import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { makeSource, citation } from '../src/core/source.mjs';
import { terms } from '../src/core/terms.mjs';

test('predeclared development corpus keeps its split, source spans and independent annotations intact', async () => {
  const root = new URL('../examples/development/', import.meta.url);
  const names = (await readdir(root)).filter(name => name.endsWith('.json')).sort();
  assert.equal(names.length, 20);
  const languages = { en: 0, ru: 0 };
  const annotations = new Set(); let spans = 0;
  for (const [index, name] of names.entries()) {
    const value = JSON.parse(await readFile(new URL(name, root), 'utf8'));
    assert.equal(value.id, `D${String(index + 1).padStart(2, '0')}`);
    assert.equal(value.schema_version, 1);
    assert.ok(Object.hasOwn(languages, value.language)); languages[value.language]++;
    const sources = new Map();
    for (const source of value.sources) {
      assert.ok(!sources.has(source.id)); sources.set(source.id, await makeSource(source));
    }
    const ids = new Set(value.annotations.map(item => item.id));
    for (const annotation of value.annotations) {
      assert.ok(!annotations.has(annotation.id)); annotations.add(annotation.id);
      const source = sources.get(annotation.source); assert.ok(source);
      const normalized = terms(Object.fromEntries(['kind', 'entity_id', 'amount', 'currency', 'owner', 'due', 'conditions']
        .map(key => [key, annotation[key]])));
      assert.equal(normalized.kind, annotation.kind);
      if (annotation.owner !== null) assert.ok(source.participants.some(person => person.person_id === annotation.owner));
      for (const span of annotation.evidence) {
        const checked = citation(source, { source: source.id, segment: span.segment, quote: span.quote, start: span.start, end: span.end });
        assert.equal(checked.supported, true, annotation.id); spans++;
      }
      for (const related of [annotation.supersedes, ...(annotation.conflicts_with ?? [])].filter(Boolean)) assert.ok(ids.has(related));
    }
    for (const negative of value.negative_evidence) {
      const source = sources.get(negative.source); assert.ok(source);
      const checked = citation(source, { source: source.id, segment: negative.segment, quote: negative.quote, start: negative.start, end: negative.end });
      assert.equal(checked.supported, true, `${value.id} negative evidence`); spans++;
    }
    assert.equal(value.expected.wrong_fulfillments, 0);
    for (const expected of value.expected.commitments) assert.ok(ids.has(expected.annotation));
  }
  assert.deepEqual(languages, { en: 10, ru: 10 });
  assert.equal(annotations.size, 24);
  assert.equal(spans, 58);
});
