// CI check (PLAN §3.1): runs the fragment merge and fails if package.json would change.
// Compares in memory instead of `git diff` so it also works before package.json is committed.
import { readFileSync } from "node:fs";
import { computeMerged } from "./merge-contributes.mjs";

try {
  const { pkgPath, text } = await computeMerged();
  const current = readFileSync(pkgPath, "utf8").replace(/\r\n/g, "\n");
  if (current !== text) {
    console.error("contributes:check: package.json is out of date with contributes/*.json — run `npm run contributes` and commit the result");
    process.exit(1);
  }
  console.log("contributes:check: fragments merge cleanly and package.json is up to date");
} catch (e) {
  console.error(`contributes:check: ${e.message}`);
  process.exit(1);
}
