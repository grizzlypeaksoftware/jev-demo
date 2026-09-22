// Run every case in guard-cases.js through the guard and compare with the
// expected verdict.
//
// Run: npm run guard

import { writeFile } from "node:fs/promises";
import { createGuard } from "./guard.js";
import cases from "./guard-cases.js";

const RESULTS_FILE = new URL("./guard-results.json", import.meta.url);

const apiKey = process.env["JEV-KEY"];
if (!apiKey) {
  console.error("Missing JEV-KEY. Put it in .env and run with `npm run guard`.");
  process.exit(1);
}

const guard = createGuard({ apiKey });
const results = await Promise.all(cases.map(async (c) => ({ ...c, ...(await guard(c)) })));

console.table(
  results.map((r) => {
    const a = r.answers;
    return {
      case: r.name,
      expected: r.expected,
      verdict: r.verdict,
      ok: r.verdict === r.expected ? "✓" : "✗",
      jev: `${a.recommendation.choice} (${a.recommendation.confidence.toFixed(2)})`,
      floor: r.floor,
      match: a.matches_request.noul.toFixed(2),
      scope: a.exceeds_scope.noul.toFixed(2),
      inject: a.injected.noul.toFixed(2),
      risk: a.risk.score.toFixed(1),
    };
  }),
);

const passed = results.filter((r) => r.verdict === r.expected).length;
console.log(`${passed}/${results.length} match the expected verdict`);
for (const r of results) console.log(`- ${r.name}: ${r.verdict}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`);

await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");
