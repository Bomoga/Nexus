#!/usr/bin/env node
// Seeds the Nexus demo repo (PLAN L1-26): a small TypeScript "cart" service with ~40 commits across
// main, feature/checkout, feature/coupons, fix/rounding, docs/readme and chore/ci, 5 merges and 2 tags,
// committer dates spread over the 36 hours before --t0, two authors, and ONE planted bug at src/cart.ts:42-48
// (the discount comes off once per line instead of once per unit), so `npm test` fails on one test.
//
//   node demo/seed.mjs --out <dir> [--t0 <ISO time>] [--force]   seed the repo
//   node demo/seed.mjs --fix-check [--out <dir>] [--t0 <ISO>]    seed, prove the test fails, apply the fix, prove it passes
//
// Deterministic: the same --t0 always produces the same commit hashes. No network, no dependencies: the demo
// repo's tests run on Node's built-in test runner (Node 22.18+/24 runs .ts files natively).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_T0 = "2026-11-07T03:15:00Z";   // same as contracts/fixtures T0
const HISTORY_HOURS = 36;
const MARKER = "nexus-demo-seed";            // lives in .git/, so --force only ever deletes directories this script made

// The planted bug lives here; contracts fixtures point at these lines (CodeRef src/cart.ts 42-48).
export const BUG_FILE = "src/cart.ts";
export const BUG_START_LINE = 42;
export const BUG_END_LINE = 48;
const BUGGY = "    sum += item.unitPrice * item.qty - cart.discountPerUnit;";
const FIXED = "    sum += (item.unitPrice - cart.discountPerUnit) * item.qty;";

const AUTHORS = {
  A: { name: "Adrian Demo", email: "adrian@demo.invalid" },
  B: { name: "Brandon Demo", email: "brandon@demo.invalid" },
};

// ---------------------------------------------------------------- file contents

const CART_TS = [
  "// Shopping cart totals for the Nexus demo service.",                          // 1
  'import { roundCents } from "./pricing.ts";',                                    // 2
  "",                                                                              // 3
  "export interface LineItem {",                                                   // 4
  "  sku: string;",                                                                // 5
  "  unitPrice: number; // dollars",                                               // 6
  "  qty: number;",                                                                // 7
  "}",                                                                             // 8
  "",                                                                              // 9
  "export interface Cart {",                                                       // 10
  "  items: LineItem[];",                                                          // 11
  "  discountPerUnit: number; // dollars off each unit",                           // 12
  "}",                                                                             // 13
  "",                                                                              // 14
  "export function emptyCart(): Cart {",                                           // 15
  "  return { items: [], discountPerUnit: 0 };",                                   // 16
  "}",                                                                             // 17
  "",                                                                              // 18
  "export function addItem(cart: Cart, item: LineItem): Cart {",                   // 19
  "  const existing = cart.items.find(i => i.sku === item.sku);",                  // 20
  "  if (existing) {",                                                             // 21
  "    return {",                                                                  // 22
  "      ...cart,",                                                                // 23
  "      items: cart.items.map(i => (i.sku === item.sku ? { ...i, qty: i.qty + item.qty } : i)),", // 24
  "    };",                                                                        // 25
  "  }",                                                                           // 26
  "  return { ...cart, items: [...cart.items, item] };",                           // 27
  "}",                                                                             // 28
  "",                                                                              // 29
  "export function itemCount(cart: Cart): number {",                               // 30
  "  return cart.items.reduce((n, i) => n + i.qty, 0);",                           // 31
  "}",                                                                             // 32
  "",                                                                              // 33
  "export function subtotal(cart: Cart): number {",                                // 34
  "  return roundCents(cart.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0));", // 35
  "}",                                                                             // 36
  "",                                                                              // 37
  "// Total after the per-unit discount: the cart's discount is set once and",    // 38
  "// comes off every unit, so a line with qty 3 loses 3x the discount.",          // 39
  "// Never negative.",                                                             // 40
  "",                                                                              // 41
  "export function total(cart: Cart): number {",                                   // 42
  "  let sum = 0;",                                                                // 43
  "  for (const item of cart.items) {",                                            // 44
  BUGGY,                                                                           // 45
  "  }",                                                                           // 46
  "  return roundCents(Math.max(sum, 0));",                                        // 47
  "}",                                                                             // 48
  "",
].join("\n");

const PRICING_TS = `// Price helpers shared by cart and checkout.
export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}
`;

const CART_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, emptyCart, itemCount, subtotal, total } from "../src/cart.ts";

const cartWith = (qty: number, discountPerUnit = 0) => ({ items: [{ sku: "A", unitPrice: 10, qty }], discountPerUnit });

test("adds items and merges the same sku", () => {
  const cart = addItem(addItem(emptyCart(), { sku: "A", unitPrice: 10, qty: 1 }), { sku: "A", unitPrice: 10, qty: 2 });
  assert.equal(cart.items.length, 1);
  assert.equal(itemCount(cart), 3);
});

test("computes the subtotal", () => {
  assert.equal(subtotal(cartWith(3)), 30);
});

test("total without a discount equals the subtotal", () => {
  assert.equal(total(cartWith(3)), 30);
});

test("applies discount per unit", () => {
  // 3 units at $10 with $1 off each unit
  assert.equal(total(cartWith(3, 1)), 27);
});

test("total never goes below zero", () => {
  assert.equal(total({ items: [{ sku: "A", unitPrice: 1, qty: 1 }], discountPerUnit: 5 }), 0);
});
`;

const FORMAT_TS = `import { roundCents } from "./pricing.ts";

export function formatMoney(dollars: number): string {
  return "$" + roundCents(dollars).toFixed(2);
}
`;

const CHECKOUT_TS = `import { total, type Cart } from "./cart.ts";

export interface Order {
  id: string;
  total: number;
  status: "pending" | "paid";
}

export function startCheckout(cart: Cart, id: string): Order {
  return { id, total: total(cart), status: "pending" };
}
`;

const COUPONS_TS = `export interface Coupon {
  code: string;
  kind: "percent" | "fixed";
  amount: number;
  expires?: string; // ISO date
}
`;

// ---------------------------------------------------------------- history

const w = (path, content) => ({ op: "write", path, content });
const ap = (path, content) => ({ op: "append", path, content });
const sub = (path, from, to) => ({ op: "replace", path, from, to });

/**
 * Steps in chronological order. h = hours after the start of the 36 h history window.
 * Branch steps create a branch from the current main; merge steps merge --no-ff into main.
 */
const STEPS = [
  { h: 0.5, branch: "main", by: "A", msg: "init project", ops: [
    w("package.json", JSON.stringify({ name: "nexus-demo-cart", version: "0.0.0", private: true, type: "module", scripts: { test: 'node --test "test/**/*.test.ts"' } }, null, 2) + "\n"),
    w(".gitignore", "node_modules/\n") ] },
  { h: 1.5, branch: "main", by: "B", msg: "add pricing helpers", ops: [w("src/pricing.ts", PRICING_TS)] },
  { h: 3, branch: "main", by: "A", msg: "add cart module", ops: [w("src/cart.ts", CART_TS)] },
  { h: 4, branch: "main", by: "B", msg: "add cart tests", ops: [w("test/cart.test.ts", CART_TEST)] },
  { h: 5, branch: "main", by: "A", msg: "add readme", ops: [w("README.md", "# nexus-demo-cart\n\nA tiny cart service used to demo Nexus.\n\nRun the tests with `npm test`.\n")] },
  { h: 6, branch: "main", by: "B", msg: "ignore build output", ops: [ap(".gitignore", "dist/\n")] },
  { h: 6.5, branch: "main", by: "A", msg: "release 0.1.0", tag: "v0.1.0", ops: [sub("package.json", '"version": "0.0.0"', '"version": "0.1.0"')] },

  { h: 7, newBranch: "feature/checkout" },
  { h: 7.5, branch: "feature/checkout", by: "A", msg: "add checkout skeleton", ops: [w("src/checkout.ts", CHECKOUT_TS)] },
  { h: 8, branch: "main", by: "B", msg: "add money formatter", ops: [w("src/format.ts", FORMAT_TS)] },
  { h: 9, newBranch: "feature/coupons" },
  { h: 9.5, branch: "feature/checkout", by: "A", msg: "mark orders as paid", ops: [ap("src/checkout.ts", '\nexport function markPaid(order: Order): Order {\n  return { ...order, status: "paid" };\n}\n')] },
  { h: 9.75, branch: "feature/coupons", by: "B", msg: "add coupon type", ops: [w("src/coupons.ts", COUPONS_TS)] },
  { h: 10.5, branch: "main", by: "A", msg: "document money formatter", ops: [ap("README.md", "\n## Formatting\n\n`formatMoney(12.5)` returns `$12.50`.\n")] },
  { h: 11, branch: "feature/coupons", by: "B", msg: "add percent coupons", ops: [ap("src/coupons.ts", "\nexport function percentOff(price: number, c: Coupon): number {\n  return price * (1 - c.amount / 100);\n}\n")] },
  { h: 12, branch: "feature/checkout", by: "B", msg: "add flat shipping rule", ops: [ap("src/checkout.ts", "\nexport const FLAT_SHIPPING = 5;\n\nexport function shippingFor(order: Order): number {\n  return order.total >= 50 ? 0 : FLAT_SHIPPING;\n}\n")] },
  { h: 13.5, branch: "feature/coupons", by: "A", msg: "add fixed coupons", ops: [ap("src/coupons.ts", "\nexport function fixedOff(price: number, c: Coupon): number {\n  return Math.max(price - c.amount, 0);\n}\n")] },
  { h: 14, branch: "feature/checkout", by: "B", msg: "test checkout totals", ops: [w("test/checkout.test.ts", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { startCheckout, markPaid } from "../src/checkout.ts";\n\ntest("checkout starts pending and can be paid", () => {\n  const order = startCheckout({ items: [{ sku: "A", unitPrice: 10, qty: 2 }], discountPerUnit: 0 }, "o1");\n  assert.equal(order.status, "pending");\n  assert.equal(order.total, 20);\n  assert.equal(markPaid(order).status, "paid");\n});\n')] },
  { h: 15, branch: "main", by: "B", msg: "test money formatter", ops: [w("test/format.test.ts", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { formatMoney } from "../src/format.ts";\n\ntest("formats dollars", () => {\n  assert.equal(formatMoney(12.5), "$12.50");\n});\n')] },
  { h: 16, branch: "feature/coupons", by: "B", msg: "test coupons", ops: [w("test/coupons.test.ts", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { percentOff, fixedOff } from "../src/coupons.ts";\n\ntest("percent and fixed coupons", () => {\n  assert.equal(percentOff(100, { code: "P10", kind: "percent", amount: 10 }), 90);\n  assert.equal(fixedOff(8, { code: "F10", kind: "fixed", amount: 10 }), 0);\n});\n')] },
  { h: 17, branch: "feature/checkout", by: "A", msg: "add shipping to checkout totals", ops: [ap("src/checkout.ts", "\nexport function grandTotal(order: Order): number {\n  return order.total + shippingFor(order);\n}\n")] },
  { h: 19, branch: "feature/coupons", by: "B", msg: "reject expired coupons", ops: [ap("src/coupons.ts", "\nexport function isExpired(c: Coupon, now: string): boolean {\n  return c.expires !== undefined && c.expires < now;\n}\n")] },
  { h: 19.5, branch: "feature/coupons", by: "A", msg: "normalize coupon codes", ops: [ap("src/coupons.ts", "\nexport function normalizeCode(code: string): string {\n  return code.trim().toUpperCase();\n}\n")] },
  { h: 20, branch: "feature/checkout", by: "A", msg: "test shipping rules", ops: [ap("test/checkout.test.ts", '\ntest("shipping is free over 50", async () => {\n  const { shippingFor } = await import("../src/checkout.ts");\n  assert.equal(shippingFor({ id: "o2", total: 60, status: "pending" }), 0);\n  assert.equal(shippingFor({ id: "o3", total: 10, status: "pending" }), 5);\n});\n')] },
  { h: 22, merge: "feature/checkout", by: "A", msg: "merge feature/checkout" },
  { h: 23.5, merge: "feature/coupons", by: "B", msg: "merge feature/coupons" },

  { h: 24, newBranch: "fix/rounding" },
  { h: 24.5, branch: "fix/rounding", by: "A", msg: "round half cents correctly", ops: [sub("src/pricing.ts", "return Math.round(value * 100) / 100;", "return Math.round((value + Number.EPSILON) * 100) / 100;")] },
  { h: 26, branch: "fix/rounding", by: "A", msg: "test rounding", ops: [w("test/pricing.test.ts", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { roundCents, toCents } from "../src/pricing.ts";\n\ntest("rounds half cents up", () => {\n  assert.equal(roundCents(1.005), 1.01);\n});\n\ntest("converts dollars to cents", () => {\n  assert.equal(toCents(2.5), 250);\n});\n')] },
  { h: 27.5, branch: "fix/rounding", by: "B", msg: "document rounding rule", ops: [ap("src/pricing.ts", "\n// roundCents rounds half cents up; the epsilon avoids 1.005 landing on 1.00.\n")] },
  { h: 27.75, branch: "fix/rounding", by: "B", msg: "test negative rounding", ops: [ap("test/pricing.test.ts", '\ntest("rounds negatives toward zero at half cents", () => {\n  assert.equal(roundCents(-0.004), -0);\n});\n')] },
  { h: 28.5, merge: "fix/rounding", by: "A", msg: "merge fix/rounding" },

  { h: 29, newBranch: "docs/readme" },
  { h: 29.5, branch: "docs/readme", by: "B", msg: "add api section to readme", ops: [ap("README.md", "\n## API\n\n- `addItem(cart, item)`\n- `total(cart)`\n- `startCheckout(cart, id)`\n")] },
  { h: 30, branch: "main", by: "A", msg: "release 0.2.0", ops: [sub("package.json", '"version": "0.1.0"', '"version": "0.2.0"')] },
  { h: 30.5, branch: "docs/readme", by: "B", msg: "add coupons section to readme", ops: [ap("README.md", "\n## Coupons\n\nPercent and fixed coupons live in `src/coupons.ts`.\n")] },
  { h: 31.5, merge: "docs/readme", by: "B", msg: "merge docs/readme" },

  { h: 32, newBranch: "chore/ci" },
  { h: 32.5, branch: "chore/ci", by: "A", msg: "add test workflow", ops: [w(".github/workflows/test.yml", "name: test\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: npm test\n")] },
  { h: 33.5, branch: "chore/ci", by: "A", msg: "run tests on pull requests", ops: [sub(".github/workflows/test.yml", "on: [push]", "on: [push, pull_request]")] },
  { h: 33.75, branch: "chore/ci", by: "B", msg: "name the ci job", ops: [sub(".github/workflows/test.yml", "  test:\n    runs-on", "  unit-tests:\n    runs-on")] },
  { h: 34.5, merge: "chore/ci", by: "A", msg: "merge chore/ci" },
  { h: 35, branch: "main", by: "A", msg: "add changelog", tag: "v0.2.0", ops: [w("CHANGELOG.md", "# Changelog\n\n## 0.2.0\n\n- checkout with shipping\n- percent and fixed coupons\n- half-cent rounding fix\n\n## 0.1.0\n\n- cart and pricing helpers\n")] },
];

// ---------------------------------------------------------------- helpers

function git(cwd, args, extraEnv = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function parseArgs(argv) {
  const a = { force: false, fixCheck: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out") a.out = value(++i, k);
    else if (k === "--t0") a.t0 = value(++i, k);
    else if (k === "--force") a.force = true;
    else if (k === "--fix-check") a.fixCheck = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function applyOps(dir, ops) {
  for (const o of ops) {
    const file = join(dir, o.path);
    mkdirSync(dirname(file), { recursive: true });
    if (o.op === "write") writeFileSync(file, o.content);
    else if (o.op === "append") writeFileSync(file, readFileSync(file, "utf8") + o.content);
    else {
      const text = readFileSync(file, "utf8");
      if (!text.includes(o.from)) throw new Error(`seed bug: "${o.from}" not found in ${o.path}`);
      writeFileSync(file, text.replace(o.from, o.to));
    }
  }
}

function assertBugPlacement(dir) {
  const lines = readFileSync(join(dir, BUG_FILE), "utf8").split("\n");
  const ok = lines[BUG_START_LINE - 1] === "export function total(cart: Cart): number {" && lines[BUG_END_LINE - 1] === "}" && lines[44] === BUGGY;
  if (!ok) throw new Error(`seed bug: ${BUG_FILE} lines ${BUG_START_LINE}-${BUG_END_LINE} are not the planted total() function`);
}

// ---------------------------------------------------------------- seeding

export function seed({ out, t0 = DEFAULT_T0, force = false }) {
  const dir = resolve(out);
  const start = Date.parse(t0) - HISTORY_HOURS * 3_600_000;
  if (Number.isNaN(start)) throw new Error(`invalid --t0 ${t0}`);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    if (!force) throw new Error(`${dir} is not empty (use --force to replace a previous demo repo)`);
    if (!existsSync(join(dir, ".git", MARKER))) throw new Error(`${dir} was not created by this script (no .git/${MARKER}); refusing to delete it`);
    const cwd = resolve(process.cwd());
    if (cwd === dir || cwd.startsWith(dir + sep)) throw new Error(`cannot replace ${dir} while it is the current directory; run the script from elsewhere`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });

  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".git", MARKER), `seeded ${t0}\n`);

  const when = h => new Date(start + h * 3_600_000).toISOString().replace(".000Z", "Z");
  const envFor = (by, h) => {
    const a = AUTHORS[by];
    const d = when(h);
    return { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: d, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email, GIT_COMMITTER_DATE: d };
  };

  let born = false;                            // `git checkout main` fails before the first commit exists
  for (const s of STEPS) {
    if (s.newBranch) { git(dir, ["checkout", "-q", "-b", s.newBranch, "main"]); continue; }
    if (s.merge) {
      git(dir, ["checkout", "-q", "main"]);
      git(dir, ["merge", "-q", "--no-ff", "-m", s.msg, s.merge], envFor(s.by, s.h));
      continue;
    }
    if (born) git(dir, ["checkout", "-q", s.branch]);
    applyOps(dir, s.ops);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", s.msg], envFor(s.by, s.h));
    born = true;
    if (s.tag) git(dir, ["tag", s.tag]);
  }
  git(dir, ["checkout", "-q", "main"]);
  assertBugPlacement(dir);

  return {
    dir,
    commits: Number(git(dir, ["rev-list", "--count", "--all"])),
    merges: Number(git(dir, ["rev-list", "--count", "--merges", "main"])),
    branches: git(dir, ["branch", "--format=%(refname:short)"]).split("\n"),
    tags: git(dir, ["tag"]).split("\n"),
    head: git(dir, ["rev-parse", "HEAD"]),
  };
}

function npmTest(dir) {
  // Same command as the repo's `npm test` script, run directly so no shell is involved.
  const r = spawnSync(process.execPath, ["--test", "test/**/*.test.ts"], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function fixCheck(dir) {
  const before = npmTest(dir);
  if (before.code !== 1) throw new Error(`fix-check: expected npm test to exit 1 on the seeded repo, got ${before.code}`);
  if (!/applies discount per unit/.test(before.out)) throw new Error("fix-check: the failing test is not 'applies discount per unit'");
  const file = join(dir, BUG_FILE);
  const text = readFileSync(file, "utf8");
  if (!text.includes(BUGGY)) throw new Error("fix-check: buggy line not found");
  writeFileSync(file, text.replace(BUGGY, FIXED));
  const after = npmTest(dir);
  if (after.code !== 0) throw new Error(`fix-check: expected npm test to pass after the fix, got ${after.code}\n${after.out}`);
  return "fix-check ok: 1 failing test before the fix, all passing after";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const temp = args.out === undefined;
  if (temp && !args.fixCheck) throw new Error("--out <dir> is required");
  const out = args.out ?? mkdtempSync(join(tmpdir(), "nexus-demo-"));
  try {
    const info = seed({ out, t0: args.t0, force: args.force || temp });
    console.log(`seeded ${info.dir}: ${info.commits} commits, ${info.merges} merges into main, branches [${info.branches.join(", ")}], tags [${info.tags.join(", ")}], HEAD ${info.head.slice(0, 8)}`);
    if (args.fixCheck) console.log(fixCheck(info.dir));
  } finally {
    if (temp) rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`demo/seed: ${e.message}`); process.exit(2); }
}
