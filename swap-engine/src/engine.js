/*
 * FoodLG Swap Calculation Engine v0.4.0
 *
 * Two separate functions, by design:
 *   calculate()  — deterministic nutrition change for one rule. No user data.
 *   rank()       — orders calculated swaps for a user, using a separate,
 *                  versioned weight config that must be dietitian-approved.
 *
 * Formula, per nutrient N:
 *   ΔN = Σ_i (to_g_i − from_g_i) × N_i / 100
 * Removed ingredients have to_g < from_g; added ingredients (substitutions)
 * have from_g = 0. Both sides are always calculated.
 *
 * Rules:
 *   - "insufficient" evidence returns no numbers, ever.
 *   - Any missing, non-finite, negative or implausible value makes the result
 *     insufficient; the engine never fills a gap with a guess.
 *   - A result can be "verified" only if every source used is confirmed on
 *     its primary record.
 *   - Every result carries an audit trail sufficient to reproduce it:
 *     versions, dataset and rule hashes, source records, the nutrient
 *     values used and each calculation input.
 */
(function (root) {
  "use strict";

  const ENGINE_VERSION = "0.4.0";
  const NUTRIENTS = ["energy_kcal", "carbohydrate_g", "sugar_g", "fat_g", "satfat_g", "sodium_mg"];
  const DECIMALS = { energy_kcal: 0, carbohydrate_g: 1, sugar_g: 1, fat_g: 1, satfat_g: 1, sodium_mg: 0 };
  // Physical upper bounds per 100 g. Pure fat is ~900 kcal; table salt ~38,800 mg sodium.
  const MAX_PER100 = { energy_kcal: 902, carbohydrate_g: 100, sugar_g: 100, fat_g: 100, satfat_g: 100, sodium_mg: 40000 };
  const MAX_QUANTITY_G = 2000; // more than any single hawker serving
  const EVIDENCE = ["verified", "estimated", "insufficient"];

  const isNum = v => typeof v === "number" && Number.isFinite(v);

  function round(value, dp) {
    const f = Math.pow(10, dp);
    const r = Math.round(Math.abs(value) * f) / f;
    return (value < 0 ? -r : r) + 0; // + 0 turns -0 into 0
  }

  // Canonical JSON (sorted keys) + FNV-1a 32-bit: identical content gives an identical hash in Node and browsers.
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }
  function hash(v) {
    const s = canonical(v);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return "fnv1a32:" + h.toString(16).padStart(8, "0");
  }

  /* ---------- schema validation ---------- */

  function validateIngredient(ing) {
    const errors = [];
    if (!ing || typeof ing.id !== "string" || !ing.id) errors.push("ingredient without id");
    const id = ing && ing.id;
    if (!ing || !ing.source || typeof ing.source !== "object") errors.push(id + ": missing source");
    if (!ing || !ing.per100g || typeof ing.per100g !== "object") { errors.push(id + ": missing per100g"); return errors; }
    for (const n of NUTRIENTS) {
      const v = ing.per100g[n];
      if (v === null || v === undefined) continue; // allowed: means "not yet sourced"
      if (!isNum(v)) errors.push(id + ": " + n + " is not a finite number");
      else if (v < 0) errors.push(id + ": " + n + " is negative");
      else if (v > MAX_PER100[n]) errors.push(id + ": " + n + " exceeds plausible maximum " + MAX_PER100[n]);
    }
    const p = ing.per100g;
    if (isNum(p.sugar_g) && isNum(p.carbohydrate_g) && p.sugar_g > p.carbohydrate_g + 0.01) errors.push(id + ": sugar exceeds carbohydrate");
    if (isNum(p.satfat_g) && isNum(p.fat_g) && p.satfat_g > p.fat_g + 0.01) errors.push(id + ": saturated fat exceeds total fat");
    return errors;
  }

  function validateDataset(data) {
    const errors = [];
    if (!data || !Array.isArray(data.ingredients)) return ["dataset has no ingredients array"];
    if (typeof data.version !== "string") errors.push("dataset has no version");
    const seen = new Set();
    for (const ing of data.ingredients) {
      if (ing && seen.has(ing.id)) errors.push("duplicate ingredient id " + ing.id);
      if (ing) seen.add(ing.id);
      errors.push(...validateIngredient(ing));
    }
    return errors;
  }

  function validateRule(rule) {
    const errors = [];
    if (!rule || typeof rule.id !== "string") return ["rule without id"];
    if (!EVIDENCE.includes(rule.evidence)) errors.push(rule.id + ": unknown evidence level");
    if (!Array.isArray(rule.changes)) errors.push(rule.id + ": changes must be an array");
    else for (const c of rule.changes) {
      if (!c || typeof c.ingredient !== "string") { errors.push(rule.id + ": change without ingredient"); continue; }
      for (const k of ["from_g", "to_g"]) {
        const v = c[k];
        if (!isNum(v)) errors.push(rule.id + ": " + k + " for " + c.ingredient + " is not a finite number");
        else if (v < 0) errors.push(rule.id + ": " + k + " for " + c.ingredient + " is negative");
        else if (v > MAX_QUANTITY_G) errors.push(rule.id + ": " + k + " for " + c.ingredient + " exceeds " + MAX_QUANTITY_G + " g");
      }
      if (isNum(c.from_g) && isNum(c.to_g) && c.from_g === c.to_g) errors.push(rule.id + ": change for " + c.ingredient + " has no effect");
      if (c.retained_fraction !== undefined && c.retained_fraction !== null &&
          (!isNum(c.retained_fraction) || c.retained_fraction < 0 || c.retained_fraction > 1)) {
        errors.push(rule.id + ": retained_fraction for " + c.ingredient + " must be between 0 and 1");
      }
    }
    return errors;
  }

  function validateLibrary(lib) {
    if (!lib || !Array.isArray(lib.rules)) return ["library has no rules array"];
    const errors = [];
    const ids = new Set(), dishes = new Set((lib.dishes || []).map(d => d.id));
    for (const r of lib.rules) {
      if (r && ids.has(r.id)) errors.push("duplicate rule id " + r.id);
      if (r) ids.add(r.id);
      if (r && !dishes.has(r.dish)) errors.push((r && r.id) + ": unknown dish " + (r && r.dish));
      errors.push(...validateRule(r));
    }
    return errors;
  }

  /* ---------- calculation ---------- */

  function calculate(rule, ingredientData, ruleLibraryVersion) {
    const audit = {
      engine_version: ENGINE_VERSION,
      ingredient_dataset_version: ingredientData && ingredientData.version,
      ingredient_dataset_hash: hash(ingredientData),
      rule_library_version: ruleLibraryVersion,
      rule_hash: hash(rule),
      formula: "ΔN = Σ (to_g − from_g) × N_per100g / 100",
      steps: []
    };
    const out = (evidence, delta, reason, extra) => ({
      rule_id: rule && rule.id, evidence, delta, reason: reason || null,
      gaps: (rule && rule.gaps) || [], assumptions: (rule && rule.assumptions) || [],
      tradeoffs: [], displayable_publicly: false, audit, ...(extra || {})
    });
    const fail = reason => out("insufficient", null, reason);

    const ruleErrors = validateRule(rule);
    if (ruleErrors.length) return fail("Invalid rule: " + ruleErrors.join("; "));
    if (rule.evidence === "insufficient") return fail("Rule marked insufficient evidence");
    if (rule.changes.length === 0) return fail("Rule has no quantified ingredient changes");

    const index = {};
    (ingredientData && ingredientData.ingredients || []).forEach(i => { if (i) index[i.id] = i; });

    const sum = {};
    NUTRIENTS.forEach(n => { sum[n] = 0; });

    for (const c of rule.changes) {
      const ing = index[c.ingredient];
      if (!ing) return fail("Unknown ingredient " + c.ingredient);
      const ingErrors = validateIngredient(ing);
      if (ingErrors.length) return fail("Invalid ingredient data: " + ingErrors.join("; "));
      const used = {};
      for (const n of NUTRIENTS) {
        const v = ing.per100g[n];
        if (!isNum(v)) return fail("No sourced value for " + n + " in " + c.ingredient);
        used[n] = v;
      }
      // Ingredients such as cooking oil need a documented retention fraction:
      // oil added to the wok is not the same as oil eaten.
      let retained = 1;
      if (ing.requires_retention) {
        if (!isNum(c.retained_fraction) || typeof c.retention_basis !== "string" || !c.retention_basis) {
          return fail("Retention in the finished dish not established for " + c.ingredient);
        }
        retained = c.retained_fraction;
      }
      const dm = (c.to_g - c.from_g) * retained;
      const contribution = {};
      for (const n of NUTRIENTS) { contribution[n] = dm * used[n] / 100; sum[n] += contribution[n]; }
      audit.steps.push({
        ingredient: c.ingredient, direction: c.from_g === 0 ? "added" : dm < 0 ? "reduced" : "increased",
        from_g: c.from_g, to_g: c.to_g, delta_g: dm,
        retained_fraction: ing.requires_retention ? retained : null, retention_basis: ing.requires_retention ? c.retention_basis : null,
        nutrient_values_used_per100g: used, contribution_unrounded: contribution,
        source: { ...ing.source }
      });
    }

    const delta = {};
    NUTRIENTS.forEach(n => { delta[n] = round(sum[n], DECIMALS[n]); });

    let evidence = rule.evidence;
    const allConfirmed = audit.steps.every(s => s.source.verification === "confirmed_primary");
    if (evidence === "verified" && !allConfirmed) evidence = "estimated";

    const context = (rule.context_validity && rule.context_validity.status) || "unconfirmed";
    return out(evidence, delta, null, {
      pathway: "ingredient",
      context_validity: context,
      tradeoffs: NUTRIENTS.filter(n => delta[n] > 0),
      displayable_publicly: evidence === "verified" && context === "confirmed" &&
        rule.clinical_review === "approved" && rule.release_status === "approved"
    });
  }

  /* ---------- published whole-beverage reference pathway ---------- */

  /*
   * Compares two items from ONE published reference document, so both share a
   * serving definition and nutrient basis. Reports only nutrients the source
   * covers. Never merged with ingredient results; see reconcile().
   * Evidence is at most "estimated": a published comparison of typical drinks
   * does not establish a specific stall's recipe.
   */
  function compareReference(rule, referenceData) {
    const rc = rule && rule.reference_comparison;
    const base = { rule_id: rule && rule.id, pathway: "published_reference", reference_version: referenceData && referenceData.version, reference_hash: hash(referenceData) };
    const none = reason => ({ ...base, evidence: "insufficient", delta_source_unit: null, delta: null, reason });
    if (!rc) return none("Rule has no published reference comparison");
    const ref = ((referenceData && referenceData.references) || []).find(r => r.id === rc.reference);
    if (!ref) return none("Unknown reference " + rc.reference);
    if (ref.source.verification !== "confirmed_primary") return none("Reference source not confirmed on its primary page");
    const a = ref.items[rc.from_item], b = ref.items[rc.to_item];
    if (!a || !b) return none("Reference does not list both items (" + rc.from_item + ", " + rc.to_item + ")");
    // Comparability first: the published items must be the drinks the rule describes.
    if (!rc.expected) return none("Rule does not declare the drink formulations it compares");
    const same = (x, y) => canonical(x) === canonical(y);
    const mismatched = [];
    if (!same(a.formulation, rc.expected.from)) mismatched.push(rc.from_item);
    if (!same(b.formulation, rc.expected.to)) mismatched.push(rc.to_item);
    if (mismatched.length) {
      return { ...none("Published item formulation differs from the rule: " + mismatched.join(", ")), classification: "not_comparable_formulation" };
    }
    const vals = item => item.conflict ? item.conflict.values : [item.value];
    for (const v of vals(a).concat(vals(b))) if (!isNum(v) || v < 0) return none("Invalid reference value");

    const diffs = [];
    for (const x of vals(a)) for (const y of vals(b)) diffs.push(y - x);
    const lo = Math.min(...diffs), hi = Math.max(...diffs);
    const conflicts = [a, b].filter(i => i.conflict).map(i => i.conflict.note);

    const conv = ((referenceData.conversions) || []).find(c => c.from_unit === ref.nutrient_basis);
    const toG = conv && isNum(conv.factor) && conv.factor > 0 ? v => round(v * conv.factor, 1) : null;
    const nutrient = conv ? conv.to_unit : null;

    const result = {
      ...base,
      evidence: "estimated",
      covers: ref.covers,
      source: { ...ref.source }, serving_definition: ref.serving_definition, nutrient_basis: ref.nutrient_basis,
      items: { from: rc.from_item, to: rc.to_item },
      delta_source_unit: conflicts.length ? null : round(lo, 2),
      delta_source_unit_range: conflicts.length ? [round(lo, 2), round(hi, 2)] : null,
      conflicts,
      conversion: conv ? { id: conv.id, factor: conv.factor, verification: conv.source.verification } : null,
      delta: null, delta_range: null,
      classification: conflicts.length ? "internal_contradiction" : "comparable",
      describes: "standard_published"
    };
    if (toG && nutrient) {
      if (conflicts.length) result.delta_range = { [nutrient]: [toG(lo), toG(hi)] };
      else result.delta = { [nutrient]: toG(lo) };
    }
    return result;
  }

  /*
   * Puts the two pathways side by side. Never averages them.
   * Checks run in this order, and a numerical tolerance is applied only when
   * everything before it passes:
   *   1. formulation      — are both describing the same drink?        → not_comparable_formulation
   *   2. internal         — does the published source agree with itself? → internal_contradiction
   *   3. context          — same recipe basis (standard vs stall/illustrative)? → context_mismatch
   *   4. conversion       — is the unit conversion sourced?             → consistent_with_blockers
   *   5. tolerance        — numbers within the agreed difference?       → discrepant | consistent
   * Only 5 is a true numerical discrepancy. 1–3 are comparability problems.
   */
  function reconcile(ingredientResult, referenceResult, tolerance, rule) {
    const hasIng = !!(ingredientResult && ingredientResult.delta);
    const hasRef = !!(referenceResult && (referenceResult.delta || referenceResult.delta_range));
    if (referenceResult && referenceResult.classification === "not_comparable_formulation") {
      return { status: "not_comparable_formulation", comparisons: [], blockers: [referenceResult.reason] };
    }
    if (!hasIng && !hasRef) return { status: "no_numbers", comparisons: [], blockers: ["Neither pathway produced a number"] };
    if (!hasIng || !hasRef) {
      return { status: "single_pathway", comparisons: [], blockers: [hasIng ? "No published reference to cross-check" : "No ingredient calculation to cross-check"] };
    }
    const sideBySide = () => (referenceResult.covers || []).map(n => {
      const refVals = referenceResult.delta ? [referenceResult.delta[n]] : referenceResult.delta_range[n];
      return { nutrient: n, ingredient: ingredientResult.delta[n], reference: refVals.length === 1 ? refVals[0] : refVals, numerical_comparison_meaningful: false };
    });
    if (referenceResult.conflicts.length) {
      return { status: "internal_contradiction", comparisons: sideBySide(),
        blockers: ["Published source conflicts with itself: " + referenceResult.conflicts.join("; ")] };
    }
    const basis = rule && rule.recipe_basis;
    if (basis !== referenceResult.describes) {
      return { status: "context_mismatch", comparisons: sideBySide(),
        blockers: ["Ingredient rule uses a " + (basis || "undeclared") + " recipe; the published figure describes a standard drink, so the numbers cannot be compared directly"] };
    }
    const blockers = [];
    if (!referenceResult.conversion || referenceResult.conversion.verification !== "confirmed_primary") blockers.push("Unit conversion is not sourced");
    const comparisons = [];
    for (const n of referenceResult.covers || []) {
      const tol = tolerance && isNum(tolerance[n]) ? tolerance[n] : 0;
      const ing = ingredientResult.delta[n];
      const refVals = referenceResult.delta ? [referenceResult.delta[n]] : referenceResult.delta_range[n];
      if (!isNum(ing) || !refVals || !refVals.every(isNum)) continue;
      const diff = Math.max(...refVals.map(v => Math.abs(ing - v)));
      const within = diff <= tol;
      comparisons.push({ nutrient: n, ingredient: ing, reference: refVals.length === 1 ? refVals[0] : refVals, max_difference: round(diff, 1), tolerance: tol, within_tolerance: within });
      if (!within) blockers.push(n + ": ingredient result " + ing + " vs published " + refVals.join(" to ") + " differs by " + round(diff, 1) + " (tolerance " + tol + ")");
    }
    const discrepant = comparisons.some(c => !c.within_tolerance);
    return { status: discrepant ? "discrepant" : blockers.length ? "consistent_with_blockers" : "consistent", comparisons, blockers };
  }

  /* ---------- ranking (separate from calculation) ---------- */

  /*
   * Benefit is normalised to a share of a daily reference amount, so mg of sodium,
   * g of sugar and kcal are comparable. Increases in any weighted nutrient count
   * against the swap, multiplied by adverse_multiplier. Ease scales the result.
   * The output says whether the weights are approved; callers must not show an
   * unapproved ranking to users.
   */
  function rank(results, rulesById, config, prefs) {
    if (!config || !config.daily_reference || !config.weights) throw new Error("ranking config missing");
    const disliked = new Set((prefs && prefs.disliked) || []);
    const ranked = results
      .filter(r => r && r.delta && !disliked.has(r.rule_id))
      .map(r => {
        let benefit = 0, harm = 0;
        const parts = {};
        for (const n of Object.keys(config.weights)) {
          const ref = config.daily_reference[n];
          if (!isNum(ref) || ref <= 0) throw new Error("invalid daily reference for " + n);
          const share = -r.delta[n] / ref * config.weights[n]; // positive = improvement
          parts[n] = share;
          if (share >= 0) benefit += share; else harm += -share;
        }
        const net = benefit - harm * (config.adverse_multiplier || 1);
        const ease = rulesById[r.rule_id].ease;
        const factor = isNum(config.ease_factor[ease]) ? config.ease_factor[ease] : 0;
        return { rule_id: r.rule_id, ease, net_benefit: net, score: net * factor, components: parts, has_adverse_tradeoff: harm > 0 };
      })
      .filter(x => x.net_benefit > 0)
      .sort((a, b) => b.score - a.score || (a.rule_id < b.rule_id ? -1 : 1));
    return { weights_version: config.version, weights_approved: config.approved === true, ranked };
  }

  /*
   * Release gate: the four gates stay distinct and all must pass.
   *   1. mathematical validity   (calculate produced numbers)
   *   2. source verification     (evidence "verified": all sources primary-confirmed)
   *   3. context validity        (local ingredient and quantity confirmed)
   *   4. dietitian + release approval
   * plus: no unresolved discrepancy with a published reference.
   */
  function gate(rule, ingredientResult, reconciliation) {
    const reasons = [];
    if (!ingredientResult || !ingredientResult.delta) reasons.push("No valid ingredient calculation");
    else {
      if (ingredientResult.evidence !== "verified") reasons.push("Sources not all confirmed on primary records");
      if (ingredientResult.context_validity !== "confirmed") reasons.push("Local ingredient and quantity not confirmed");
    }
    if (rule.clinical_review !== "approved") reasons.push("Dietitian review not approved");
    if (rule.release_status !== "approved") reasons.push("Release not approved");
    if (reconciliation && reconciliation.status !== "consistent" && reconciliation.status !== "single_pathway") {
      reasons.push(...(reconciliation.blockers.length ? reconciliation.blockers : ["Reconciliation status " + reconciliation.status]));
    }
    return { rule_id: rule.id, releasable: reasons.length === 0, reasons };
  }

  const api = { ENGINE_VERSION, NUTRIENTS, calculate, compareReference, reconcile, gate, rank, validateDataset, validateLibrary, hash };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FoodLGEngine = api;
})(typeof self !== "undefined" ? self : this);
