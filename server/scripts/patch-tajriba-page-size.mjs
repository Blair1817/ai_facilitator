// Raise the Tajriba admin `scopes` query's nested `attributes(first: 100)`
// page size to 2000.
//
// Why: a game scope accumulates chat + llmLog + operational-events
// attributes, easily exceeding 100. The admin `scopes` query only returned
// the first 100 attributes per scope, silently truncating the rest and
// making scalar reads (totalInterventions, sequenceId, …) flaky in the
// export. Tajriba v1.7.0's top-level `Query.attributes` resolver is
// unimplemented (it panics), so pagination via `admin.attributes` is not
// viable — the page size must be raised at the query source instead.
//
// This patch edits both generated Tajriba entry points. It is run by the
// server package's postinstall hook so every clean `npm ci` applies the same
// query before the production server is bundled.
//
//   node server/scripts/patch-tajriba-page-size.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const targets = ["index.js", "index.cjs"].map((file) =>
  path.resolve(here, "../node_modules/@empirica/tajriba/dist", file),
);
const EXPECTED_ATTRIBUTE_QUERIES_PER_BUNDLE = 4;

// Match only the generated `attributes(first: 100)` field. The package has
// shipped both quoted and unquoted object keys, so the matcher intentionally
// accepts either representation while leaving unrelated `first: 100`
// arguments unchanged.
const ATTRIBUTE_FIRST = /((?:["']?value["']?\s*:\s*["']attributes["'])[\s\S]{0,800}?(?:["']?value["']?\s*:\s*["']first["'])[\s\S]{0,800}?(?:["']?kind["']?\s*:\s*["']IntValue["'])[\s\S]{0,200}?(?:["']?value["']?\s*:\s*["'])(100|2000)(["']))/g;

export function patchTajribaBundleSource(source) {
  let targetCount = 0;
  let replacementCount = 0;
  const patched = source.replace(ATTRIBUTE_FIRST, (match, _whole, size) => {
    targetCount += 1;
    if (size === "2000") return match;
    replacementCount += 1;
    return match.replace(/100(["'])$/, "2000$1");
  });
  return { source: patched, targetCount, replacementCount };
}

export function assertExpectedTajribaQueryCount(target, targetCount) {
  if (targetCount !== EXPECTED_ATTRIBUTE_QUERIES_PER_BUNDLE) {
    throw new Error(
      `expected ${EXPECTED_ATTRIBUTE_QUERIES_PER_BUNDLE} generated attributes(first: ...) queries in ${target}; found ${targetCount}`,
    );
  }
}

function main() {
  let replacements = 0;
  let verifiedTargets = 0;
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      throw new Error(`required Tajriba bundle not found: ${target}`);
    }
    const original = fs.readFileSync(target, "utf8");
    const patched = patchTajribaBundleSource(original);
    assertExpectedTajribaQueryCount(target, patched.targetCount);
    verifiedTargets += patched.targetCount;
    replacements += patched.replacementCount;
    if (patched.replacementCount > 0) fs.writeFileSync(target, patched.source);
  }
  const action = replacements > 0 ? `applied ${replacements} replacement(s)` : "already applied";
  console.log(`tajriba page-size patch: ${action}; verified ${verifiedTargets} query document(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    main();
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exit(1);
  }
}
