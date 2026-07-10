#!/usr/bin/env node
/**
 * Keep the desktop model catalog and WebView model picker aligned with the
 * current official Codex model catalog.
 */
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { relPath, SRC_DIR, PROJECT_ROOT } = require("./patch-util");

const CATALOG_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const GPT56_SLUGS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "CodexDesktop-Rebuild" } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          resolve(fetchJson(response.headers.location));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Official catalog request failed: HTTP ${response.statusCode}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Official catalog is not valid JSON: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog.models)) throw new Error("Official catalog has no models array");
  const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));
  const expected = {
    "gpt-5.6-sol": ALL_EFFORTS,
    "gpt-5.6-terra": ALL_EFFORTS,
    "gpt-5.6-luna": ALL_EFFORTS.slice(0, -1),
  };

  for (const [slug, efforts] of Object.entries(expected)) {
    const model = bySlug.get(slug);
    if (!model) throw new Error(`Official catalog is missing ${slug}`);
    const actual = (model.supported_reasoning_levels || []).map((level) => level.effort);
    if (actual.join(",") !== efforts.join(",")) {
      throw new Error(`${slug} has unexpected reasoning efforts: ${actual.join(",")}`);
    }
    if (model.context_window !== 372000) {
      throw new Error(`${slug} has unexpected context window: ${model.context_window}`);
    }
  }
  if (bySlug.has("gpt-5.6-pro")) throw new Error("Unexpected gpt-5.6-pro in official catalog");
}

function fallbackModels(catalog) {
  return catalog.models
    .filter((model) => GPT56_SLUGS.has(model.slug))
    .map((model) => ({
      model: model.slug,
      displayName: model.display_name,
      description: model.description,
      defaultReasoningEffort: model.default_reasoning_level,
      supportedReasoningEfforts: model.supported_reasoning_levels.map((level) => ({
        reasoningEffort: level.effort,
        description: level.description,
      })),
      hidden: false,
      isDefault: false,
      contextWindow: model.context_window,
      toolMode: model.tool_mode,
      useResponsesLite: model.use_responses_lite,
      multiAgentVersion: model.multi_agent_version,
      serviceTiers: model.service_tiers,
      additionalSpeedTiers: model.additional_speed_tiers,
      __codexGpt56Fallback: true,
    }));
}

function platformsFor(platform) {
  return (platform ? [platform] : ["mac-arm64", "mac-x64", "win"]).filter((name) =>
    fs.existsSync(path.join(SRC_DIR, name, "_asar", "webview", "assets")),
  );
}

function assetFiles(platform) {
  const files = [];
  for (const name of platformsFor(platform)) {
    const dir = path.join(SRC_DIR, name, "_asar", "webview", "assets");
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".js")) files.push({ platform: name, path: path.join(dir, file) });
    }
  }
  return files;
}

function replaceOnce(source, search, replacement, change, changes) {
  if (!source.includes(search)) return source;
  changes.push(change);
  return source.replace(search, replacement);
}

function patchSource(source, serializedFallback) {
  const changes = [];
  let next = source;

  if (next.includes("supportedReasoningEfforts") && !next.includes("__codexGpt56Merge")) {
    const helper =
      `const __codexGpt56Fallback=${serializedFallback};` +
      "function __codexGpt56Merge(e){let t=new Set(e.map(e=>e.model));return e.concat(__codexGpt56Fallback.filter(e=>!t.has(e.model)))}";
    const filterPattern =
      /function ([A-Za-z_$][\w$]*)\(\{authMethod:([A-Za-z_$][\w$]*),availableModels:([A-Za-z_$][\w$]*),defaultModel:([A-Za-z_$][\w$]*),enabledReasoningEfforts:([A-Za-z_$][\w$]*),includeUltraReasoningEffort:([A-Za-z_$][\w$]*),models:([A-Za-z_$][\w$]*),useHiddenModels:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=\[\],/;
    const match = next.match(filterPattern);
    if (match) {
      const [, fn, auth, available, defaultModel, efforts, ultra, models, hidden, output] = match;
      const original = match[0];
      const replacement =
        `${helper}function ${fn}({authMethod:${auth},availableModels:${available},defaultModel:${defaultModel},enabledReasoningEfforts:${efforts},includeUltraReasoningEffort:${ultra},models:${models},useHiddenModels:${hidden}}){` +
        `${models}=__codexGpt56Merge(${models});let ${output}=[],`;
      next = next.replace(original, replacement);
      const normalFilter = `if(${hidden}?${available}.has(${defaultModel}.model):!${defaultModel}.hidden){`;
      const fallbackFilter = `if(${hidden}?${available}.has(${defaultModel}.model)||${defaultModel}.__codexGpt56Fallback:!${defaultModel}.hidden){`;
      next = replaceOnce(next, normalFilter, fallbackFilter, "conditionally inject missing official GPT-5.6 models", changes);
      changes.push("add official GPT-5.6 WebView fallback catalog");
    }
  }

  next = next.replace(
    /if\(([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\.has\(([A-Za-z_$][\w$]*)\.model\):!\3\.hidden\)\{/g,
    (whole, visible, available, model) => {
      changes.push("show GPT-5.6 fallback when hidden-model filtering is enabled");
      return `if(${visible}?${available}.has(${model}.model)||${model}.__codexGpt56Fallback:!${model}.hidden){`;
    },
  );

  next = next.replace(/([A-Za-z_$][\w$]*)=\[`low`,`medium`,`high`,`xhigh`\]/g, (whole, name) => {
    changes.push("enable max and ultra reasoning efforts");
    return `${name}=[\`low\`,\`medium\`,\`high\`,\`xhigh\`,\`max\`,\`ultra\`]`;
  });

  next = next.replace(
    /(\blet\s+[A-Za-z_$][\w$]*=[^;]+?,\s*)([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,`1186680773`\)/g,
    (whole, prefix, ultra) => {
      changes.push("remove Ultra Statsig display gate");
      return `${prefix}${ultra}=!0`;
    },
  );
  next = next.replace(
    /includeUltraReasoningEffort:[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,`1186680773`\)/g,
    () => {
      changes.push("remove Ultra thread-start Statsig gate");
      return "includeUltraReasoningEffort:!0";
    },
  );

  next = replaceOnce(
    next,
    "threadSettings:{model:t,effort:n,multiAgentMode:ft}",
    "threadSettings:{model:t,effort:n,reasoning_effort:n,multiAgentMode:ft}",
    "pass manually selected reasoning effort to next turn",
    changes,
  );

  next = next.replace(
    /l\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.find\(e=>\{let\{reasoningEffort:t\}=e;return t===([A-Za-z_$][\w$]*)\}\)\?\.reasoningEffort\?\?([A-Za-z_$][\w$]*)\)/g,
    (whole, model, efforts, selected, defaultEffort) => {
      changes.push("use the selected model's official default effort");
      return `l(${model},${defaultEffort})`;
    },
  );
  next = next.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.find\(e=>\{let\{reasoningEffort:t\}=e;return t===([A-Za-z_$][\w$]*)\.reasoningEffort\}\)\?\.reasoningEffort\?\?([A-Za-z_$][\w$]*);t\(\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\1\)/g,
    (whole, effort, supported, settings, defaultEffort, close, setModel, model) => {
      changes.push("use the selected model's official default effort");
      return `let ${effort}=${defaultEffort};${close}(),${setModel}(${model},${effort})`;
    },
  );

  const setDefaultPattern =
    /let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(`set-default-model-config-for-host`,\{hostId:([A-Za-z_$][\w$]*),model:([A-Za-z_$][\w$]*),reasoningEffort:([A-Za-z_$][\w$]*),profile:([A-Za-z_$][\w$]*)\.profile\}\);/g;
  next = next.replace(setDefaultPattern, (whole, result, invoke, hostId, model, effort, settings) => {
    changes.push("write GPT-5.6 model and effort through batch config updates");
    return (
      `let ${result}=/^gpt-5\\.6-(sol|terra|luna)$/u.test(${model})?await ${invoke}(\`batch-write-config-value\`,{hostId:${hostId},edits:[` +
      `{keyPath:${settings}.profile==null?\`model\`:\`profiles.\${${settings}.profile}.model\`,value:${model},mergeStrategy:\`upsert\`},` +
      `{keyPath:${settings}.profile==null?\`model_reasoning_effort\`:\`profiles.\${${settings}.profile}.model_reasoning_effort\`,value:${effort},mergeStrategy:\`upsert\`}],filePath:null,expectedVersion:null,reloadUserConfig:!0}):` +
      `await ${invoke}(\`set-default-model-config-for-host\`,{hostId:${hostId},model:${model},reasoningEffort:${effort},profile:${settings}.profile});`
    );
  });

  return { code: next, changes };
}

function upsertRootToml(lines, key, value) {
  const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = tableIndex === -1 ? lines.length : tableIndex;
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let index = 0; index < end; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return;
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
}

function updateLocalConfig(catalogPath, check) {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const lines = content === "" ? [] : content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const tomlPath = catalogPath.replace(/'/g, "''");
  upsertRootToml(lines, "model_catalog_json", `'${tomlPath}'`);
  upsertRootToml(lines, "model_reasoning_effort", '"xhigh"');
  upsertRootToml(lines, "service_tier", '"priority"');
  if (!check) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${lines.join("\n")}\n`, "utf8");
  }
  return configPath;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const catalog = await fetchJson(CATALOG_URL);
  validateCatalog(catalog);

  const catalogPath = path.join(PROJECT_ROOT, "model-catalog.json");
  if (!check) fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const configPath = updateLocalConfig(catalogPath, check);
  const serializedFallback = JSON.stringify(fallbackModels(catalog));
  let updated = 0;
  let matched = 0;

  for (const target of assetFiles(platform)) {
    const source = fs.readFileSync(target.path, "utf8");
    if (!source.includes("supportedReasoningEfforts") && !source.includes("1186680773")) continue;
    const { code, changes } = patchSource(source, serializedFallback);
    if (changes.length === 0) continue;
    matched += 1;
    if (!check && code !== source) {
      fs.writeFileSync(target.path, code, "utf8");
      updated += 1;
    }
    console.log(`  [${target.platform}] ${relPath(target.path)}: ${[...new Set(changes)].join(", ")}`);
  }

  console.log(`  [ok] official catalog: ${catalog.models.length} models -> ${relPath(catalogPath)}`);
  console.log(`  [ok] local config: ${configPath}`);
  console.log(check ? `  [?] ${matched} WebView file(s) patchable` : `  [ok] ${updated} WebView file(s) updated`);
}

main().catch((error) => {
  console.error(`  [x] ${error.message}`);
  process.exit(1);
});
