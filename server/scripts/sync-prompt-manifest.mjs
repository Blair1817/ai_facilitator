// Recompute provenance after an intentional reviewed Prompt edit; no model/network calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(server, "src/prompts/source/runtime");
const manifestPath = path.join(source, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const hash = input => createHash("sha256").update(input).digest("hex");
manifest.files = {};
for (const folder of ["specialist", "control_50", "frozen_control"]) {
  for (const entry of fs.readdirSync(path.join(source, folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) throw new Error("Unexpected nested or linked prompt source");
    const filename = `${folder}/${entry.name}`;
    const buffer = fs.readFileSync(path.join(source, filename));
    manifest.files[filename] = { sha256: hash(buffer), bytes: buffer.length };
  }
}
for (const route of Object.values(manifest.routes)) {
  route.generatorSha256 = hash(route.generatorFiles.map(file => fs.readFileSync(path.join(source, file), "utf8")).join(manifest.compositionSeparator));
  route.validatorSha256 = hash(fs.readFileSync(path.join(source, route.validatorFile)));
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
if (process.argv.includes("--fixtures")) fs.cpSync(source, path.join(server, "test/participant_sim/prompts/source/runtime"), { recursive: true });
console.log(`Updated ${Object.keys(manifest.files).length} prompt hashes; runtime version ${manifest.version}.`);
