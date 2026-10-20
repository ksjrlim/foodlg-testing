const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/engine.js");
const ingredients = require("../data/ingredients.json");
const library = require("../data/rules.json");
const references = require("../data/references.json");
const config = require("../data/ranking.json");

const byId = Object.fromEntries(library.rules.map(r => [r.id, r]));
const clone = o => JSON.parse(JSON.stringify(o));
const tol = config.reconciliation.tolerance;
const ref = (id, data = references) => engine.compareReference(byId[id], data);
const ing = id => engine.calculate(byId[id], ingredients, library.version);
const withRetention = () => { const r = clone(byId["SWAP-CK-001"]); r.changes[0].retained_fraction = 1; r.changes[0].retention_basis = "test fixture"; return r; };
const confirmConversion = () => { const d = clone(references); d.conversions[0].source.verification = "confirmed_primary"; return d; };

/* --- published reference pathway --- */

test("teh to teh siu dai: HealthHub 5 → 4 tsp = −1 tsp = −5 g sugar", () => {
  const r = ref("SWAP-TT-001");
  assert.equal(r.pathway, "published_reference");
  assert.equal(r.delta_source_unit, -1);
  assert.deepEqual(r.delta, { sugar_g: -5 });
  assert.equal(r.source.url, "https://www.healthhub.sg/live-healthy/say-siu-dai-instead");
});

test("reference reports only nutrients its source covers", () => {
  const r = ref("SWAP-TT-001");
  assert.deepEqual(r.covers, ["sugar_g"]);
  assert.deepEqual(Object.keys(r.delta), ["sugar_g"]);
});

test("reference evidence is never above estimated", () => {
  for (const id of ["SWAP-TT-001", "SWAP-KP-001", "SWAP-KP-002"]) assert.equal(ref(id).evidence, "estimated", id);
});

test("kopi to kopi-O kosong: 4 → 0 tsp = −20 g sugar", () => {
  assert.deepEqual(ref("SWAP-KP-001").delta, { sugar_g: -20 });
});

test("self-conflicting source gives a range, never a single number", () => {
  const r = ref("SWAP-KP-002");
  assert.equal(r.delta, null);
  assert.equal(r.delta_source_unit, null);
  assert.deepEqual(r.delta_source_unit_range, [-1, -0.5]);
  assert.deepEqual(r.delta_range, { sugar_g: [-5, -2.5] });
  assert.equal(r.conflicts.length, 1);
});

test("items must come from the same reference document", () => {
  const rule = { id: "T", reference_comparison: { reference: "REF-HH-SIU-DAI", from_item: "kopi", to_item: "kopi_siu_dai" } };
  const r = engine.compareReference(rule, references);
  assert.equal(r.delta, null);
  assert.match(r.reason, /does not list both items/);
});

test("unconfirmed reference source is not used", () => {
  const d = clone(references); d.references[0].source.verification = "matched_secondary";
  assert.equal(ref("SWAP-TT-001", d).delta, null);
});

test("invalid reference values are rejected", () => {
  for (const bad of [NaN, Infinity, -1, "4"]) {
    const d = clone(references); d.references[0].items.teh.value = bad;
    assert.equal(ref("SWAP-TT-001", d).delta, null, String(bad));
  }
});

test("no conversion means source units only", () => {
  const d = clone(references); d.conversions = [];
  const r = ref("SWAP-TT-001", d);
  assert.equal(r.delta_source_unit, -1);
  assert.equal(r.delta, null);
});

test("rule without a reference returns insufficient", () => {
  assert.equal(ref("SWAP-CK-001").evidence, "insufficient");
});

/* --- reconciliation: never merged, discrepancies block --- */

test("teh siu dai: illustrative recipe vs standard published drink is a context mismatch, not a numerical discrepancy", () => {
  const rec = engine.reconcile(ing("SWAP-TT-001"), ref("SWAP-TT-001"), tol, byId["SWAP-TT-001"]);
  assert.equal(rec.status, "context_mismatch");
  assert.equal(rec.comparisons[0].numerical_comparison_meaningful, false);
  assert.ok(rec.blockers.some(b => /cannot be compared directly/.test(b)));
});

test("same recipe basis: −8.2 g vs −5 g is a true numerical discrepancy", () => {
  const rule = { ...byId["SWAP-TT-001"], recipe_basis: "standard_published" };
  const rec = engine.reconcile(ing("SWAP-TT-001"), ref("SWAP-TT-001"), tol, rule);
  assert.equal(rec.status, "discrepant");
  assert.equal(rec.comparisons[0].max_difference, 3.2);
});

test("reconciliation never averages the two pathways", () => {
  const rec = engine.reconcile(ing("SWAP-TT-001"), ref("SWAP-TT-001"), tol, byId["SWAP-TT-001"]);
  assert.equal(rec.comparisons[0].ingredient, -8.2);
  assert.equal(rec.comparisons[0].reference, -5);
  assert.ok(!("combined" in rec) && !("average" in rec));
});

test("agreeing pathways are consistent only once the conversion is sourced", () => {
  const fake = { delta: { sugar_g: -5.5 } };
  const std = { ...byId["SWAP-TT-001"], recipe_basis: "standard_published" };
  const r1 = engine.reconcile(fake, ref("SWAP-TT-001"), tol, std);
  assert.equal(r1.status, "consistent_with_blockers");
  assert.ok(r1.blockers.some(b => /conversion/.test(b)));
  const r2 = engine.reconcile(fake, ref("SWAP-TT-001", confirmConversion()), tol, std);
  assert.equal(r2.status, "consistent");
});

test("self-conflicting published source blocks reconciliation", () => {
  const fake = { delta: { sugar_g: -4 } };
  const rec = engine.reconcile(fake, ref("SWAP-KP-002", confirmConversion()), tol, { ...byId["SWAP-KP-002"], recipe_basis: "standard_published" });
  assert.equal(rec.status, "internal_contradiction");
  assert.ok(rec.blockers.some(b => /conflicts with itself/.test(b)));
});

test("one pathway only is reported as such", () => {
  assert.equal(engine.reconcile(ing("SWAP-KP-001"), ref("SWAP-KP-001"), tol).status, "single_pathway");
  assert.equal(engine.reconcile(ing("SWAP-CK-001"), ref("SWAP-CK-001"), tol).status, "no_numbers");
});

/* --- the four gates stay distinct --- */

test("every rule declares context validity, all currently unconfirmed", () => {
  for (const r of library.rules) assert.equal(r.context_validity.status, "unconfirmed", r.id);
});

test("gate lists every failing gate separately", () => {
  const g = engine.gate(byId["SWAP-TT-001"], ing("SWAP-TT-001"), engine.reconcile(ing("SWAP-TT-001"), ref("SWAP-TT-001"), tol, byId["SWAP-TT-001"]));
  assert.equal(g.releasable, false);
  for (const re of [/primary records/, /Local ingredient/, /Dietitian/, /Release not approved/, /cannot be compared directly/]) {
    assert.ok(g.reasons.some(x => re.test(x)), String(re));
  }
});

test("a confirmed USDA record alone does not satisfy context validity", () => {
  const d = clone(ingredients);
  d.ingredients.forEach(i => { i.source.verification = "confirmed_primary"; });
  const rule = { ...withRetention(), evidence: "verified", clinical_review: "approved", release_status: "approved" };
  const r = engine.calculate(rule, d, library.version);
  const g = engine.gate(rule, r, engine.reconcile(r, engine.compareReference(rule, references), tol, rule));
  assert.equal(r.evidence, "verified");
  assert.equal(g.releasable, false);
  assert.deepEqual(g.reasons, ["Local ingredient and quantity not confirmed"]);
});

test("all gates passing makes a rule releasable", () => {
  const d = clone(ingredients);
  d.ingredients.forEach(i => { i.source.verification = "confirmed_primary"; });
  const rule = { ...withRetention(), evidence: "verified", clinical_review: "approved", release_status: "approved", context_validity: { status: "confirmed", basis: "stall weighing" } };
  const r = engine.calculate(rule, d, library.version);
  assert.equal(engine.gate(rule, r, engine.reconcile(r, engine.compareReference(rule, references), tol, rule)).releasable, true);
});

test("no shipped rule is releasable", () => {
  for (const rule of library.rules) {
    const r = engine.calculate(rule, ingredients, library.version);
    const g = engine.gate(rule, r, engine.reconcile(r, engine.compareReference(rule, references), tol, rule));
    assert.equal(g.releasable, false, rule.id);
  }
});

/* --- comparability before tolerance (Phase 1.3) --- */

test("comparing kopi siu dai against kopi-C siu dai is refused as a different formulation", () => {
  const rule = clone(byId["SWAP-KP-002"]);
  rule.reference_comparison = { ...rule.reference_comparison, reference: "REF-HH-SIU-DAI", to_item: "kopi_c_siu_dai" };
  const r = engine.compareReference(rule, references);
  assert.equal(r.classification, "not_comparable_formulation");
  assert.equal(r.delta, null);
  const rec = engine.reconcile(ing("SWAP-KP-002"), r, tol, rule);
  assert.equal(rec.status, "not_comparable_formulation");
});

test("formulation is checked before any numbers are compared", () => {
  const rule = clone(byId["SWAP-TT-001"]);
  rule.reference_comparison.expected.to = { base: "tea", milk: "evaporated", sweetener: "sugar", level: "less" };
  const rec = engine.reconcile({ delta: { sugar_g: -5 } }, engine.compareReference(rule, references), tol, { ...rule, recipe_basis: "standard_published" });
  assert.equal(rec.status, "not_comparable_formulation");
  assert.deepEqual(rec.comparisons, []);
});

test("rule without declared formulations cannot use a reference", () => {
  const rule = clone(byId["SWAP-TT-001"]); delete rule.reference_comparison.expected;
  assert.equal(engine.compareReference(rule, references).delta, null);
});

test("internal contradiction is reported before context or tolerance", () => {
  const rec = engine.reconcile(ing("SWAP-KP-002"), ref("SWAP-KP-002"), tol, byId["SWAP-KP-002"]);
  assert.equal(rec.status, "internal_contradiction");
});

test("every shipped reference comparison uses matching formulations", () => {
  for (const r of library.rules.filter(x => x.reference_comparison)) {
    assert.notEqual(ref(r.id).classification, "not_comparable_formulation", r.id);
  }
});
