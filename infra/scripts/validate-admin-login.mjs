#!/usr/bin/env node

import fs from "node:fs";

const args = new Set(process.argv.slice(2));
const expectFailure = args.has("--expect-failure");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const configPath = positional[0] ?? "/run/secrets/empirica.toml";
const endpoint = positional[1] ?? "http://127.0.0.1:3000/query";

const config = fs.readFileSync(configPath, "utf8");
const username = config.match(/^username\s*=\s*"([^"]+)"$/m)?.[1];
const password = config.match(/^password\s*=\s*"([^"]+)"$/m)?.[1];
if (!username || !password) {
  console.error("FATAL: operator credential fields are missing");
  process.exit(2);
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    query:
      "mutation Login($input: LoginInput!) { login(input: $input) { sessionToken user { username } } }",
    variables: { input: { username, password } },
  }),
});
const payload = await response.json();
const login = payload?.data?.login;
const succeeded =
  typeof login?.sessionToken === "string" &&
  login.sessionToken.length >= 20 &&
  login?.user?.username === username;

if (expectFailure) {
  if (succeeded) {
    console.error("FATAL: credential unexpectedly authenticated");
    process.exit(1);
  }
  console.log("Credential correctly rejected without exposing request or response data.");
} else {
  if (!succeeded) {
    console.error("FATAL: operator login validation failed");
    process.exit(1);
  }
  console.log("Operator login validated without exposing credentials or session token.");
}
