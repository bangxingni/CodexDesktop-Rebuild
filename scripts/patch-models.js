#!/usr/bin/env node
/**
 * Post-build patch: allow GPT-5.6 models through the model whitelist.
 *
 * The model picker reads dynamic config 107580212:
 *   - available_models: hidden model whitelist
 *   - use_hidden_models: switch from "show non-hidden" to "show whitelist"
 *
 * GPT-5.6 variants can be returned by the host as hidden models. If the
 * Statsig default/config is stale, the UI filters them out. This patch keeps
 * the normal filtering behavior, but always allows model IDs starting with
 * gpt-5.6 and merges common GPT-5.6 slugs into the parsed whitelist.
 */
const fs = require("fs");
const path = require("path");
const { relPath, SRC_DIR } = require("./patch-util");

const GPT56_MODELS = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-codex", "gpt-5.6-mini"];

const MODEL_CONFIG_ORIGINAL = "availableModels:new Set(t.success?t.data:U)";
const MODEL_CONFIG_PATCHED =
  "availableModels:(e=>{let n=new Set(e);return " +
  JSON.stringify(GPT56_MODELS) +
  ".forEach(e=>n.add(e)),n})(t.success?t.data:U)";

const FILTER_ORIGINAL = "if(u?n.has(r.model):!r.hidden){";
const FILTER_PATCHED =
  "if((u?n.has(r.model):!r.hidden)||String(r.model).toLowerCase().startsWith(`gpt-5.6`)){";

function platformsFor(platform) {
  return platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );
}

function jsTargets(platform) {
  const targets = [];
  for (const plat of platformsFor(platform)) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const fullPath = path.join(assetsDir, file);
      const source = fs.readFileSync(fullPath, "utf8");
      if (
        source.includes("available_models") ||
        source.includes("use_hidden_models") ||
        source.includes("supportedReasoningEfforts")
      ) {
        targets.push({ platform: plat, path: fullPath });
      }
    }
  }
  return targets;
}

function patchSource(source) {
  const changes = [];
  let next = source;

  if (next.includes(MODEL_CONFIG_ORIGINAL)) {
    next = next.replace(MODEL_CONFIG_ORIGINAL, MODEL_CONFIG_PATCHED);
    changes.push("dynamic config 107580212 default GPT-5.6 whitelist");
  } else if (next.includes(MODEL_CONFIG_PATCHED)) {
    changes.push("dynamic config already patched");
  }

  if (next.includes(FILTER_ORIGINAL)) {
    next = next.replace(FILTER_ORIGINAL, FILTER_PATCHED);
    changes.push("model filter GPT-5.6 wildcard allow");
  } else if (next.includes(FILTER_PATCHED)) {
    changes.push("model filter already patched");
  }

  return { code: next, changes };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  let patchedFiles = 0;
  let matchedFiles = 0;

  for (const target of jsTargets(platform)) {
    const source = fs.readFileSync(target.path, "utf8");
    const { code, changes } = patchSource(source);
    const realChanges = changes.filter((change) => !change.includes("already"));
    if (changes.length === 0) continue;

    matchedFiles += 1;
    console.log(`  [${target.platform}] ${relPath(target.path)}`);
    for (const change of changes) console.log(`    * ${change}`);

    if (!isCheck && code !== source) {
      fs.writeFileSync(target.path, code, "utf8");
      patchedFiles += 1;
    } else if (realChanges.length > 0) {
      patchedFiles += 1;
    }
  }

  if (matchedFiles === 0) {
    console.log("  [skip] No model whitelist/filter chunks found");
    return;
  }

  console.log(
    isCheck
      ? `  [?] ${patchedFiles} file(s) patchable, ${matchedFiles} model chunk(s) matched`
      : `  [ok] ${patchedFiles} file(s) updated, ${matchedFiles} model chunk(s) matched`,
  );
}

main();
