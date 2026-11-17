// Copy the original SpriteForge source into the app and produce a scoped stylesheet.
//   node tools/sync-spriteforge.mjs [--check]
// Source: D:\AI\SpriteForge (override with SPRITEFORGE_SOURCE)
// The tool itself is NOT modified: index.html and app.js are copied verbatim, and
// styles.css is rewritten so that every selector is prefixed with `.sf-app`.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const SOURCE = process.env.SPRITEFORGE_SOURCE ?? "D:\\AI\\SpriteForge";
const TARGET = path.resolve("frontend/public/tools/spriteforge");
const FILES = ["index.html", "app.js", "styles.css"];
const checkOnly = process.argv.includes("--check");

/** Split a selector list on top level commas (ignores commas inside parens/brackets/quotes). */
function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of list) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const PAGE_ROOTS = /^(?::root|html|body)\b/i;

function scopeOne(selector) {
  const value = selector.trim();
  if (!value) return "";
  // The page background/margins only make sense on the document itself.
  if (/^(?:body|html)::(?:before|after)$/i.test(value)) return "";
  if (PAGE_ROOTS.test(value)) {
    const rest = value.replace(/^(?::root|html|body)/i, "").trim();
    return rest ? `.sf-app ${rest}` : ".sf-app";
  }
  return `.sf-app ${value}`;
}

function scopeSelectors(list) {
  const scoped = splitSelectors(list)
    .map(scopeOne)
    .filter(Boolean);
  return [...new Set(scoped)].join(", ");
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Walk the stylesheet, prefixing every rule and recursing into conditional at-rules. */
function scopeCss(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace === -1) break;
    const head = css.slice(i, brace);
    let depth = 0;
    let j = brace;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = css.slice(brace + 1, j);
    const trimmed = head.trim();
    if (/^@(media|supports|container|layer)\b/i.test(trimmed)) {
      out += `${head}{${scopeCss(body)}}`;
    } else if (trimmed.startsWith("@")) {
      // @keyframes / @font-face / @property: keep as is
      out += `${head}{${body}}`;
    } else {
      const selector = scopeSelectors(trimmed);
      if (selector) out += `${selector} {${body}}`;
    }
    i = j + 1;
  }
  return out;
}

const OVERRIDES = `
/* -- MiraForge host integration (appended by tools/sync-spriteforge.mjs) -- */
.sf-app {
  height: 100%;
  overflow: hidden;
}
.sf-app .workspace {
  height: calc(100% - 64px);
  min-height: 0;
}
.sf-app .modal-root,
.sf-app .toast-root,
.sf-app .progress-overlay {
  z-index: 60;
}
`;

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`source not found: ${SOURCE}`);
    process.exit(2);
  }
  await mkdir(TARGET, { recursive: true });

  const digests = {};
  for (const name of FILES) {
    const buffer = await readFile(path.join(SOURCE, name));
    digests[name] = createHash("sha256").update(buffer).digest("hex");
    if (name === "styles.css") {
      const scoped = scopeCss(stripComments(buffer.toString("utf8"))) + OVERRIDES;
      await writeFile(path.join(TARGET, "tool.css"), scoped, "utf8");
      continue;
    }
    if (!checkOnly) await writeFile(path.join(TARGET, name), buffer);
  }

  if (checkOnly) {
    let fresh = true;
    for (const name of FILES) {
      const target = path.join(TARGET, name === "styles.css" ? "tool.css" : name);
      if (!existsSync(target)) {
        console.log(`missing ${target}`);
        fresh = false;
        continue;
      }
      const current = createHash("sha256").update(await readFile(target)).digest("hex");
      if (name !== "styles.css" && current !== digests[name]) {
        console.log(`stale ${name}`);
        fresh = false;
      }
    }
    console.log(fresh ? "spriteforge vendored copy is up to date" : "run the script without --check to refresh");
    process.exit(fresh ? 0 : 1);
  }

  for (const name of FILES) console.log(`${name}  ${digests[name].slice(0, 12)}`);
  console.log(`written to ${TARGET}`);
}

await main();
