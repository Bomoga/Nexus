// Merges contributes/base.json + contributes/lane-{1,2,3}.json into package.json#contributes and
// package.json#activationEvents (PLAN §3.1). Lead-only: workers edit their lane fragment, never package.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENTS = ["base", "lane-1", "lane-2", "lane-3"];
const GENERATED_NOTE = "scripts/merge-contributes.mjs — do not edit contributes by hand";
const COMMANDS_TS = join(ROOT, "src", "contracts", "commands.ts");
const REQUIRED_ACTIVATION = ["onStartupFinished", "onUri", "onCustomEditor:nexus.home"];

// Rule 1: key -> merge kind. Output keys follow this order.
const KEYS = {
  commands: "array",
  views: "objectOfArrays",
  viewsContainers: "objectOfArrays",
  menus: "objectOfArrays",
  keybindings: "array",
  configuration: "configuration",
  themes: "array",
  customEditors: "array",
  colors: "array",
};

class MergeError extends Error {}
const fail = (msg) => { throw new MergeError(msg); };

function readFragment(name) {
  const file = join(ROOT, "contributes", `${name}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`contributes/${name}.json: ${e.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) fail(`contributes/${name}.json: must be an object`);
  for (const k of Object.keys(data)) {
    if (k !== "contributes" && k !== "activationEvents") fail(`contributes/${name}.json: unknown top-level key "${k}"`);
  }
  const contributes = data.contributes ?? {};
  const activationEvents = data.activationEvents ?? [];
  if (typeof contributes !== "object" || Array.isArray(contributes)) fail(`contributes/${name}.json: "contributes" must be an object`);
  if (!Array.isArray(activationEvents) || activationEvents.some((e) => typeof e !== "string")) {
    fail(`contributes/${name}.json: "activationEvents" must be an array of strings`);
  }
  for (const k of Object.keys(contributes)) {
    if (!(k in KEYS)) fail(`contributes/${name}.json: contributes key "${k}" is not handled by the merge script (ask the lane 1 lead)`);
  }
  return { name, contributes, activationEvents };
}

// Loads COMMANDS and COMMAND_OWNER from src/contracts/commands.ts, or null if the file does not exist yet.
async function loadCommandContract() {
  if (!existsSync(COMMANDS_TS)) return null;
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(COMMANDS_TS, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  if (!mod.COMMANDS || !mod.COMMAND_OWNER) fail("src/contracts/commands.ts must export COMMANDS and COMMAND_OWNER");
  return { commands: mod.COMMANDS, owners: mod.COMMAND_OWNER };
}

function mergeArray(out, key, value, frag) {
  if (!Array.isArray(value)) fail(`contributes/${frag}.json: contributes.${key} must be an array`);
  out[key] = [...(out[key] ?? []), ...value];
}

function mergeObjectOfArrays(out, key, value, frag) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`contributes/${frag}.json: contributes.${key} must be an object of arrays`);
  out[key] ??= {};
  for (const [sub, arr] of Object.entries(value)) {
    if (!Array.isArray(arr)) fail(`contributes/${frag}.json: contributes.${key}.${sub} must be an array`);
    out[key][sub] = [...(out[key][sub] ?? []), ...arr];
  }
}

function mergeConfiguration(out, value, frag, propertyOwner) {
  const sections = Array.isArray(value) ? value : [value];
  out.configuration ??= { title: "Nexus", properties: {} };
  for (const section of sections) {
    for (const [prop, schema] of Object.entries(section.properties ?? {})) {
      if (propertyOwner.has(prop)) fail(`duplicate configuration property "${prop}" in contributes/${propertyOwner.get(prop)}.json and contributes/${frag}.json`);
      propertyOwner.set(prop, frag);
      out.configuration.properties[prop] = schema;
    }
  }
}

export async function computeMerged() {
  const fragments = FRAGMENTS.map(readFragment);
  const contract = await loadCommandContract();
  const merged = {};
  const propertyOwner = new Map();

  // Rule 1: merge in lane order (base, 1, 2, 3).
  for (const { name, contributes } of fragments) {
    for (const key of Object.keys(KEYS)) {
      if (!(key in contributes)) continue;
      const kind = KEYS[key];
      if (kind === "array") mergeArray(merged, key, contributes[key], name);
      else if (kind === "objectOfArrays") mergeObjectOfArrays(merged, key, contributes[key], name);
      else mergeConfiguration(merged, contributes[key], name, propertyOwner);
    }
  }

  // Rule 2: every command declared once, present in COMMANDS, declared by its owner lane.
  const commandOwner = new Map();
  for (const { name, contributes } of fragments) {
    for (const cmd of contributes.commands ?? []) {
      const id = cmd?.command;
      if (typeof id !== "string") fail(`contributes/${name}.json: a command entry has no "command" id`);
      if (commandOwner.has(id)) fail(`duplicate command "${id}" in contributes/${commandOwner.get(id)}.json and contributes/${name}.json`);
      commandOwner.set(id, name);
      if (contract) {
        if (!(id in contract.commands)) fail(`contributes/${name}.json: command "${id}" is not in src/contracts/commands.ts COMMANDS`);
        if (contract.owners[id] !== name) fail(`contributes/${name}.json: command "${id}" is owned by ${contract.owners[id]} (COMMAND_OWNER)`);
      }
      // TODO(cp-0): until src/contracts/commands.ts exists, the COMMANDS / COMMAND_OWNER checks above are skipped.
    }
  }

  // Rule 3: view ids and custom editor viewTypes start with "nexus." and are unique.
  const viewIds = new Set();
  for (const [container, views] of Object.entries(merged.views ?? {})) {
    for (const view of views) {
      const id = view?.id;
      if (typeof id !== "string" || !id.startsWith("nexus.")) fail(`view "${id}" in views.${container} must start with "nexus."`);
      if (viewIds.has(id)) fail(`duplicate view id "${id}"`);
      viewIds.add(id);
    }
  }
  const viewTypes = new Set();
  for (const editor of merged.customEditors ?? []) {
    const vt = editor?.viewType;
    if (typeof vt !== "string" || !vt.startsWith("nexus.")) fail(`customEditors viewType "${vt}" must start with "nexus."`);
    if (viewTypes.has(vt)) fail(`duplicate customEditors viewType "${vt}"`);
    viewTypes.add(vt);
  }

  // Rule 4: activationEvents = sorted union, always with the required events and onView for every nexus view.
  const events = new Set(REQUIRED_ACTIVATION);
  for (const { activationEvents } of fragments) for (const e of activationEvents) events.add(e);
  for (const id of viewIds) events.add(`onView:${id}`);
  const activationEvents = [...events].sort();

  // Rule 5: write into package.json with the x-generated field first.
  const pkgPath = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const { "x-generated": _drop, ...rest } = pkg;
  const out = { "x-generated": GENERATED_NOTE, ...rest, activationEvents, contributes: merged };
  return { pkgPath, text: JSON.stringify(out, null, 2) + "\n" };
}

export async function main() {
  const { pkgPath, text } = await computeMerged();
  writeFileSync(pkgPath, text);
  console.log("merge-contributes: package.json#contributes and #activationEvents updated");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`merge-contributes: ${e instanceof MergeError ? e.message : e.stack}`);
    process.exit(1);
  });
}
