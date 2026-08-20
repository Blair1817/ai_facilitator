// Raise the Tajriba admin `scopes` query's nested `attributes(first: 100)`
// page size to 2000.
//
// Why: a game scope accumulates chat + llmLog + operational-events
// attributes, easily exceeding 100. The admin `scopes` query only returned
// the first 100 attributes per scope, silently truncating the rest and
// making scalar reads (totalInterventions, sequenceId, …) flaky in the
// export. Tajriba v1.7.3's top-level `Query.attributes` resolver is
// unimplemented (it panics), so pagination via `admin.attributes` is not
// viable — the page size must be raised at the query source instead.
//
// This patch edits `node_modules/@empirica/tajriba/dist/index.js` (the
// generated GraphQL query documents). It is baked into the production
// bundle at build time. Re-run it after `npm install` regenerates
// node_modules.
//
//   node server/scripts/patch-tajriba-page-size.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../node_modules/@empirica/tajriba/dist/index.js");

if (!fs.existsSync(target)) {
  console.error("target not found:", target);
  process.exit(1);
}

let src = fs.readFileSync(target, "utf8");
const before = src;
src = src.replace(/"value": "100"/g, '"value": "2000"');
if (src === before) {
  console.log("tajriba page-size patch: already applied");
} else {
  fs.writeFileSync(target, src);
  console.log("tajriba page-size patch: applied (first:100 -> first:2000)");
}
