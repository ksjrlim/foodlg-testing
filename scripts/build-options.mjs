// Builds rules/options.json from the swap engine's published-reference pathway.
// Patient-facing claims are generated, never typed by hand, so they cannot drift from the evidence records.
// Usage: node scripts/build-options.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const engine = require("../swap-engine/src/engine.js");
const references = require("../swap-engine/data/references.json");

const F = {
  kopi: { base: "coffee", milk: "condensed", sweetener: "in milk", level: "regular" },
  kopi_siu_dai: { base: "coffee", milk: "condensed", sweetener: "in milk", level: "less" },
  kopi_o_kosong: { base: "coffee", milk: "none", sweetener: "none", level: "none" },
  teh: { base: "tea", milk: "condensed", sweetener: "in milk", level: "regular" },
  teh_siu_dai: { base: "tea", milk: "condensed", sweetener: "in milk", level: "less" },
  teh_o_kosong: { base: "tea", milk: "none", sweetener: "none", level: "none" }
};

const DEFS = [
  { id: "OPT-KOPI-SIUDAI", name: "Kopi siu dai", from_item: "Kopi", step: "smaller", stall_dependent: true, ref: "REF-HH-YUM-SENG", a: "kopi", b: "kopi_siu_dai" },
  { id: "OPT-KOPI-O-KOSONG", name: "Kopi-O kosong", from_item: "Kopi", step: "bigger", stall_dependent: false, ref: "REF-HH-SIU-DAI", a: "kopi", b: "kopi_o_kosong" },
  { id: "OPT-TEH-SIUDAI", name: "Teh siu dai", from_item: "Teh", step: "smaller", stall_dependent: true, ref: "REF-HH-SIU-DAI", a: "teh", b: "teh_siu_dai" },
  { id: "OPT-TEH-O-KOSONG", name: "Teh-O kosong", from_item: "Teh", step: "bigger", stall_dependent: false, ref: "REF-HH-SIU-DAI", a: "teh", b: "teh_o_kosong" },
  { id: "OPT-PLAIN-WATER", name: "Plain water instead", from_item: "Kopi or teh", step: "bigger", stall_dependent: false, ref: null }
];

const tsp = n => {
  const v = Math.abs(n);
  const words = { 0.5: "½", 1: "1", 1.5: "1½" };
  return words[v] || String(v);
};

const options = DEFS.map(d => {
  if (!d.ref) {
    return { id: d.id, scope: "drink_sugar", name: d.name, from_item: d.from_item, step: d.step, stall_dependent: d.stall_dependent,
      evidence_level: "qualitative", display_claim: "No added sugar", display_note: null, benefit_tsp: null, evidence_ref: null };
  }
  const rule = { id: d.id, reference_comparison: { reference: d.ref, from_item: d.a, to_item: d.b, expected: { from: F[d.a], to: F[d.b] } } };
  const r = engine.compareReference(rule, references);
  if (r.classification === "not_comparable_formulation" || (r.delta_source_unit === null && !r.delta_source_unit_range)) {
    throw new Error(`${d.id}: reference not usable (${r.reason})`);
  }
  const range = r.delta_source_unit_range;
  const claim = range
    ? `HealthHub standard drink: about ${tsp(range[1])} to ${tsp(range[0])} teaspoon${Math.abs(range[0]) > 1 ? "s" : ""} less sugar per cup`
    : `HealthHub standard drink: about ${tsp(r.delta_source_unit)} teaspoon${Math.abs(r.delta_source_unit) === 1 ? "" : "s"} less sugar per cup`;
  return {
    id: d.id, scope: "drink_sugar", name: d.name, from_item: d.from_item, step: d.step, stall_dependent: d.stall_dependent,
    evidence_level: "published_standard", display_claim: claim, display_note: "Your stall's preparation may differ.",
    benefit_tsp: range ? -(range[0] + range[1]) / 2 : -r.delta_source_unit,
    evidence_ref: { reference: d.ref, title: r.source.title, url: r.source.url, last_reviewed: r.source.last_reviewed, reference_hash: r.reference_hash, conflicts: r.conflicts }
  };
});

writeFileSync(new URL("../rules/options.json", import.meta.url),
  JSON.stringify({ library: "FoodLG MVP drink-sugar options", version: "0.1.0", generated_from: { engine: engine.ENGINE_VERSION, references: references.version }, options }, null, 2));
console.log(options.map(o => `${o.id}: ${o.display_claim}`).join("\n"));
