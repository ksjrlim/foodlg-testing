const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/engine.js");
const ingredients = require("../data/ingredients.json");
const library = require("../data/rules.json");
const ranking = require("../data/ranking.json");

const byId = Object.fromEntries(library.rules.map(r => [r.id, r]));
const clone = o => JSON.parse(JSON.stringify(o));
const calc = (id, data = ingredients) => engine.calculate(byId[id], data, library.version);
// Test fixture only: lets us exercise rules whose real records are still pending.
const withValues = (id, per100g) => {
  const d = clone(ingredients);
  d.ingredients.find(i => i.id === id).per100g = per100g;
  return d;
};
const RICE_FIXTURE = { energy_kcal: 160, carbohydrate_g: 27, sugar_g: 0.1, fat_g: 4, satfat_g: 1.2, sodium_mg: 250 };
const COFFEE_FIXTURE = { energy_kcal: 1, carbohydrate_g: 0, sugar_g: 0, fat_g: 0, satfat_g: 0, sodium_mg: 2 };

/* --- data files --- */

test("shipped dataset and library pass schema validation", () => {
  assert.deepEqual(engine.validateDataset(ingredients), []);
  assert.deepEqual(engine.validateLibrary(library), []);
});

test("library has 14 rules: 2 calculable now, 12 without numbers", () => {
  const results = library.rules.map(r => engine.calculate(r, ingredients, library.version));
  assert.equal(results.length, 14);
  assert.equal(results.filter(r => r.delta).length, 2);
  assert.equal(results.filter(r => r.evidence === "insufficient").length, 12);
});

/* --- formula --- */

test("siew dai halves condensed milk: −15 g × 54.4 g sugar/100 g = −8.2 g", () => {
  const r = calc("SWAP-TT-001");
  assert.equal(r.delta.sugar_g, -8.2);
  assert.equal(r.delta.energy_kcal, -48);
  assert.equal(r.delta.sodium_mg, -19);
  assert.equal(r.evidence, "estimated");
});

// Test fixture: the oil rule with a stated retention, since the real retention is not yet established.
const oilWithRetention = f => { const r = clone(byId["SWAP-CK-001"]); r.changes[0].retained_fraction = f; r.changes[0].retention_basis = "test fixture"; return r; };

test("less oil: −10 g palm oil at full retention = −88 kcal, −4.9 g sat fat", () => {
  const r = engine.calculate(oilWithRetention(1), ingredients, library.version);
  assert.equal(r.delta.energy_kcal, -88);
  assert.equal(r.delta.satfat_g, -4.9);
});

test("rounding never produces negative zero", () => {
  const r = engine.calculate(oilWithRetention(1), ingredients, library.version);
  assert.ok(!Object.is(r.delta.sugar_g, -0));
});

/* --- recipe-specific ingredients --- */

test("chicken rice uses its own rice record, not plain rice", () => {
  assert.equal(byId["SWAP-CR-001"].changes[0].ingredient, "ING-RICE-CHICKEN-RICE");
  const r = calc("SWAP-CR-001");
  assert.equal(r.delta, null);
  assert.match(r.reason, /No sourced value/);
});

test("chicken rice calculates once its record has values", () => {
  const r = calc("SWAP-CR-001", withValues("ING-RICE-CHICKEN-RICE", RICE_FIXTURE));
  assert.equal(r.delta.energy_kcal, -80);
  assert.equal(r.delta.sodium_mg, -125);
});

/* --- substitutions --- */

test("kopi-O kosong is a substitution with both sides calculated", () => {
  const rule = byId["SWAP-KP-001"];
  assert.equal(rule.kind, "substitution");
  assert.ok(rule.changes.some(c => c.from_g === 0 && c.to_g > 0), "has an added ingredient");
  assert.equal(calc("SWAP-KP-001").delta, null, "pending until the coffee record is sourced");
  const r = calc("SWAP-KP-001", withValues("ING-COFFEE-BREWED", COFFEE_FIXTURE));
  // −30 g condensed milk (−96.3 kcal) + 30 g coffee (+0.3 kcal) = −96 kcal
  assert.equal(r.delta.energy_kcal, -96);
  assert.equal(r.delta.sodium_mg, -38); // −38.1 + 0.6 = −37.5, rounded half away from zero
  assert.deepEqual(r.audit.steps.map(s => s.direction), ["reduced", "added"]);
});

test("an added ingredient that raises a nutrient is flagged as a trade-off", () => {
  const rule = { id: "T-1", dish: "KP", evidence: "estimated", ease: "easy",
    changes: [{ ingredient: "ING-CONDENSED-MILK-SWEETENED", from_g: 10, to_g: 0 }, { ingredient: "ING-PALM-OIL", from_g: 0, to_g: 5, retained_fraction: 1, retention_basis: "test fixture" }] };
  const r = engine.calculate(rule, ingredients, library.version);
  assert.ok(r.delta.sugar_g < 0);
  assert.ok(r.delta.satfat_g > 0);
  assert.ok(r.tradeoffs.includes("satfat_g"));
});

/* --- input validation --- */

for (const [label, value] of [["NaN", NaN], ["Infinity", Infinity], ["a string", "54"], ["negative", -1], ["above physical maximum", 150]]) {
  test(`nutrient value that is ${label} is rejected`, () => {
    const d = clone(ingredients);
    d.ingredients.find(i => i.id === "ING-CONDENSED-MILK-SWEETENED").per100g.sugar_g = value;
    const r = calc("SWAP-TT-001", d);
    assert.equal(r.delta, null);
    assert.equal(r.evidence, "insufficient");
  });
}

for (const [label, from, to] of [["NaN", NaN, 10], ["Infinity", 30, Infinity], ["negative", -5, 10], ["implausible", 30, 5000], ["unchanged", 30, 30]]) {
  test(`quantity that is ${label} is rejected`, () => {
    const rule = clone(byId["SWAP-TT-001"]);
    rule.changes[0].from_g = from; rule.changes[0].to_g = to;
    const r = engine.calculate(rule, ingredients, library.version);
    assert.equal(r.delta, null);
    assert.match(r.reason, /Invalid rule/);
  });
}

test("dataset validator catches impossible combinations", () => {
  const d = clone(ingredients);
  d.ingredients[0].per100g.satfat_g = 5; // more than total fat 0.28
  d.ingredients.push(clone(d.ingredients[2])); // duplicate id
  const errors = engine.validateDataset(d);
  assert.ok(errors.some(e => /saturated fat exceeds total fat/.test(e)));
  assert.ok(errors.some(e => /duplicate ingredient id/.test(e)));
});

test("library validator catches unknown dishes and evidence levels", () => {
  const l = clone(library);
  l.rules[0].dish = "XX"; l.rules[1].evidence = "probably";
  const errors = engine.validateLibrary(l);
  assert.ok(errors.some(e => /unknown dish/.test(e)));
  assert.ok(errors.some(e => /unknown evidence level/.test(e)));
});

/* --- evidence gating --- */

test("insufficient evidence never returns numbers", () => {
  assert.equal(calc("SWAP-LK-001").delta, null);
});

test("secondary-source matches cannot be reported as verified", () => {
  const rule = { ...byId["SWAP-TT-001"], evidence: "verified", clinical_review: "approved", release_status: "approved" };
  const r = engine.calculate(rule, ingredients, library.version);
  assert.equal(r.evidence, "estimated");
  assert.equal(r.displayable_publicly, false);
});

test("verified only when every source is confirmed on the primary record", () => {
  const d = clone(ingredients);
  d.ingredients.find(i => i.id === "ING-CONDENSED-MILK-SWEETENED").source.verification = "confirmed_primary";
  const rule = { ...byId["SWAP-TT-001"], evidence: "verified", clinical_review: "approved", release_status: "approved" };
  const r = engine.calculate(rule, d, library.version);
  assert.equal(r.evidence, "verified");
  assert.equal(r.displayable_publicly, false, "still blocked: local context unconfirmed");
  const confirmed = { ...rule, context_validity: { status: "confirmed", basis: "test" } };
  assert.equal(engine.calculate(confirmed, d, library.version).displayable_publicly, true);
});

test("no shipped rule is publicly displayable", () => {
  for (const rule of library.rules) assert.equal(engine.calculate(rule, ingredients, library.version).displayable_publicly, false, rule.id);
});

/* --- audit trail --- */

test("audit trail lets a reviewer reproduce the result", () => {
  const r = calc("SWAP-TT-001");
  const s = r.audit.steps[0];
  assert.equal(s.source.record_id, "FDC 171275");
  assert.equal(s.source.source_version, "April 2018 (final SR Legacy release)");
  assert.equal(s.nutrient_values_used_per100g.sugar_g, 54.4);
  assert.equal(s.delta_g, -15);
  // Reproduce from the audit alone:
  const reproduced = r.audit.steps.reduce((t, st) => t + st.delta_g * st.nutrient_values_used_per100g.sugar_g / 100, 0);
  assert.equal(Math.round(reproduced * 10) / 10, r.delta.sugar_g);
});

test("dataset hash changes when any value changes, and is stable otherwise", () => {
  const a = calc("SWAP-TT-001").audit.ingredient_dataset_hash;
  assert.equal(calc("SWAP-TT-001").audit.ingredient_dataset_hash, a);
  const d = clone(ingredients); d.ingredients[4].per100g.satfat_g = 49.4;
  assert.notEqual(calc("SWAP-TT-001", d).audit.ingredient_dataset_hash, a);
});

test("identical inputs give identical outputs", () => {
  assert.deepEqual(calc("SWAP-CK-001"), calc("SWAP-CK-001"));
});

/* --- ranking --- */

const allResults = () => library.rules.map(r => engine.calculate(r, ingredients, library.version));

test("ranking reports that weights are not yet approved", () => {
  const out = engine.rank(allResults(), byId, ranking);
  assert.equal(out.weights_approved, false);
  assert.ok(out.ranked.every(x => x.net_benefit > 0));
});

test("ranking normalises units: −500 mg sodium outranks −10 kcal", () => {
  // −500 mg sodium (25% of reference) should beat −10 kcal (0.5% of reference) at equal ease.
  const mk = (id, d) => ({ rule_id: id, delta: { energy_kcal: 0, carbohydrate_g: 0, sugar_g: 0, fat_g: 0, satfat_g: 0, sodium_mg: 0, ...d } });
  const rules = { A: { ease: "easy" }, B: { ease: "easy" } };
  const out = engine.rank([mk("A", { energy_kcal: -10 }), mk("B", { sodium_mg: -500 })], rules, ranking);
  assert.equal(out.ranked[0].rule_id, "B");
});

test("adverse trade-offs reduce rank and can remove a swap", () => {
  const mk = (id, d) => ({ rule_id: id, delta: { energy_kcal: 0, carbohydrate_g: 0, sugar_g: 0, fat_g: 0, satfat_g: 0, sodium_mg: 0, ...d } });
  const rules = { clean: { ease: "easy" }, mixed: { ease: "easy" }, worse: { ease: "very easy" } };
  const out = engine.rank([
    mk("clean", { sodium_mg: -400 }),
    mk("mixed", { sodium_mg: -400, satfat_g: 1 }),
    mk("worse", { sodium_mg: -200, sugar_g: 10 })
  ], rules, ranking);
  assert.deepEqual(out.ranked.map(x => x.rule_id), ["clean", "mixed"]);
  assert.equal(out.ranked[1].has_adverse_tradeoff, true);
});

/* --- oil retention (Phase 1.3) --- */

test("oil rule returns no number until retention in the finished dish is established", () => {
  const r = calc("SWAP-CK-001");
  assert.equal(r.delta, null);
  assert.match(r.reason, /Retention/);
});

test("retention scales the oil change and is recorded in the audit", () => {
  const r = engine.calculate(oilWithRetention(0.6), ingredients, library.version);
  assert.equal(r.delta.energy_kcal, -53); // −10 g × 0.6 × 884 / 100 = −53.04
  assert.equal(r.audit.steps[0].retained_fraction, 0.6);
  assert.equal(r.audit.steps[0].retention_basis, "test fixture");
});

test("retention fraction outside 0–1 is rejected", () => {
  for (const bad of [1.2, -0.1, NaN]) {
    const r = engine.calculate(oilWithRetention(bad), ingredients, library.version);
    assert.equal(r.delta, null, String(bad));
  }
});

test("retention without a stated basis is rejected", () => {
  const rule = oilWithRetention(0.6); rule.changes[0].retention_basis = "";
  assert.equal(engine.calculate(rule, ingredients, library.version).delta, null);
});
