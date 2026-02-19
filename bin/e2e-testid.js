#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const minimist = require("minimist");
const { globSync } = require("glob");

const ALLOWED_RUNNERS = new Set(["playwright", "cypress"]);

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const TABLE_TAGS = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
]);

const BLOCK_TAGS = /^(div|span|p|h[1-6]|section|article|ul|ol|li|nav|aside|main|header|footer)$/i;

const TAG_REGEX = /<([A-Za-z][A-Za-z0-9:_-]*)(\s[^<>]*?)?(\/?)>/g;
const TESTID_ATTR_REGEX = /<([a-zA-Z0-9_-]+)([^>]*?)data-testid\s*=\s*["'`]([^"'`]+)["'`]([^>]*)>/g;

const args = minimist(process.argv.slice(2));
const cmd = args._[0];
const runner = String(args.runner || "playwright").toLowerCase();
const outDir = args.out || "e2e";
const inputFile = args.component;
const inputDir = args.dir;

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileBase(filePath) {
  return path.basename(filePath).replace(/\.[^/.]+$/, "");
}

function toKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function escapeRegex(str) {
  return String(str || "").replace(/[\/.*+?^${}()|[\]\\]/g, "\\$&");
}

function regexLiteral(text) {
  return `/${escapeRegex(text)}/i`;
}

function sanitizePart(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function getAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`, "i");
  const match = re.exec(attrs || "");
  return match ? match[1] : "";
}

function hasToken(str, token) {
  return new RegExp(`\\b${token}\\b`, "i").test(str || "");
}

function formHasOnChange(source) {
  return /<form\b[^>]*\bonchange\s*=|<form\b[^>]*\bonChange\s*=/i.test(source);
}

function hasForm(source) {
  const hasOpenTag = /<form\b[^>]*>/i.test(source);
  const hasCloseTag = /<\/form>/i.test(source);
  return hasOpenTag && hasCloseTag && !formHasOnChange(source);
}

function isCustomComponent(rawTag) {
  return /^[A-Z]/.test(rawTag || "");
}

function extractTestIds(source) {
  const targets = [];
  const seen = new Set();
  let match;

  TESTID_ATTR_REGEX.lastIndex = 0;

  while ((match = TESTID_ATTR_REGEX.exec(source)) !== null) {
    const rawTag = String(match[1]);
    const tag = rawTag.toLowerCase();
    const id = match[3];
    const attrs = `${match[2] || ""} ${match[4] || ""}`;
    const key = `${rawTag}:${id}`;

    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ id, tag, rawTag, attrs });
    }
  }

  return targets;
}

function nextTestId(baseName, tag, counters, usedIds) {
  const base = sanitizePart(baseName) || "component";
  const tagName = sanitizePart(tag) || "element";
  const count = (counters.get(tagName) || 0) + 1;
  counters.set(tagName, count);

  let id = `${base}.${tagName}-${count}`;
  let suffix = 1;
  while (usedIds.has(id)) {
    suffix += 1;
    id = `${base}.${tagName}-${count}-${suffix}`;
  }

  usedIds.add(id);
  return id;
}

function addMissingTestIds(source, componentPath) {
  if (formHasOnChange(source)) return { updated: source, added: 0 };

  const usedIds = new Set(extractTestIds(source).map((t) => t.id));
  const counters = new Map();
  const base = fileBase(componentPath);
  let added = 0;

  function closingTagExists(rawTag, fromOffset) {
    const re = new RegExp(`<\\/${escapeRegex(rawTag)}\\s*>`, "g");
    re.lastIndex = fromOffset;
    return re.test(source);
  }

  function isValidJsxTag(rawTag, attrs, selfClose, offset, fullMatch) {
    const prevChar = offset > 0 ? source[offset - 1] : "";
    if (/[A-Za-z0-9_$.]/.test(prevChar)) return false;
    if ((attrs || "").includes("\n")) return false;
    const lowerTag = String(rawTag || "").toLowerCase();
    if (selfClose === "/") return true;
    if (VOID_TAGS.has(lowerTag)) return true;
    return closingTagExists(rawTag, offset + fullMatch.length);
  }

  const updated = source.replace(TAG_REGEX, (full, tag, attrs, selfClose, offset) => {
    if (String(full).startsWith("</")) return full;
    if (/^\s*!/.test(tag) || /^\/$/.test(tag)) return full;
    if (!isValidJsxTag(tag, attrs, selfClose, offset, full)) return full;
    if (/\bdata-testid\s*=/.test(attrs || "")) return full;
    if (/\bonchange\s*=|\bonChange\s*=/.test(attrs || "")) return full;

    const id = nextTestId(base, tag, counters, usedIds);
    const rawAttrs = attrs || "";
    const space = rawAttrs.length > 0 && /\s$/.test(rawAttrs) ? "" : " ";
    added += 1;

    if (selfClose === "/") return `<${tag}${rawAttrs}${space}data-testid="${id}" />`;
    return `<${tag}${rawAttrs}${space}data-testid="${id}">`;
  });

  return { updated, added };
}

function classifyTarget(target) {
  const attrs = target.attrs || "";
  const typeAttr = (getAttr(attrs, "type") || "").toLowerCase();
  const roleAttr = (getAttr(attrs, "role") || "").toLowerCase();
  const asAttr = (getAttr(attrs, "as") || "").toLowerCase();
  const idHint = (target.id || "").toLowerCase();
  const postHint = /(success|error|message|toast|alert|result|notice|banner)/i.test(idHint);

  const effectiveTag = ["input", "textarea", "select", "button"].includes(asAttr)
    ? asAttr
    : target.tag;

  if (effectiveTag === "input") {
    if (typeAttr === "checkbox") return { kind: "checkbox", post: postHint };
    if (typeAttr === "radio") return { kind: "radio", post: postHint };
    if (typeAttr === "file") return { kind: "file", post: postHint };
    if (typeAttr === "submit" || typeAttr === "button") return { kind: "button", post: postHint };
    return { kind: "text", post: postHint };
  }

  if (effectiveTag === "textarea") return { kind: "text", post: postHint };
  if (effectiveTag === "select") return { kind: "select", post: postHint };
  if (effectiveTag === "button") return { kind: "button", post: postHint };
  if (effectiveTag === "a") return { kind: "link", post: postHint };

  const roleMap = {
    button: "button",
    checkbox: "checkbox",
    radio: "radio",
    textbox: "text",
    searchbox: "text",
    combobox: "combobox",
  };
  if (roleMap[roleAttr]) return { kind: roleMap[roleAttr], post: postHint };

  if (isCustomComponent(target.rawTag)) {
    if (/(input|textfield|textbox|field)/i.test(target.rawTag) || /(input|field|email|password|username|name|search)/i.test(idHint))
      return { kind: "maybeText", post: postHint };
    if (/(select|dropdown|combobox)/i.test(target.rawTag) || /(select|dropdown|option)/i.test(idHint))
      return { kind: "maybeSelect", post: postHint };
    if (/(button|btn)/i.test(target.rawTag) || /(submit|save|login|continue|confirm|next)/i.test(idHint))
      return { kind: "maybeButton", post: postHint };
    if (/(checkbox|check)/i.test(target.rawTag) || /(agree|terms|remember)/i.test(idHint))
      return { kind: "maybeCheckbox", post: postHint };
    if (/(radio)/i.test(target.rawTag))
      return { kind: "maybeRadio", post: postHint };
  }

  if (TABLE_TAGS.has(target.tag)) return { kind: "visible", post: false };

  return {
    kind: "visible",
    post: postHint || BLOCK_TAGS.test(target.tag),
  };
}

function pickSubmitButton(candidates) {
  if (!candidates.length) return null;

  const scoreId = (id) => {
    const s = (id || "").toLowerCase();
    let score = 0;
    if (/(submit|save|login|sign|confirm|continue|next|send)/i.test(s)) score += 10;
    if (/(cancel|back|close|dismiss)/i.test(s)) score -= 8;
    if (/(button|btn)/i.test(s)) score += 2;
    return score;
  };

  return candidates.reduce((best, current) =>
    scoreId(current) > scoreId(best) ? current : best
  );
}

function inferRole(target) {
  const attrs = target.attrs || "";
  const explicitRole = (getAttr(attrs, "role") || "").toLowerCase();
  if (explicitRole) return explicitRole;

  const tag = (target.tag || "").toLowerCase();
  const typeAttr = (getAttr(attrs, "type") || "").toLowerCase();

  const roleByTag = {
    button: "button",
    a: "link",
    select: "combobox",
    textarea: "textbox",
    img: "img",
    h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading",
  };

  if (roleByTag[tag]) return roleByTag[tag];

  if (tag === "input") {
    if (typeAttr === "checkbox") return "checkbox";
    if (typeAttr === "radio") return "radio";
    if (typeAttr === "submit" || typeAttr === "button") return "button";
    return "textbox";
  }

  return "";
}

function inferAccessibleName(target) {
  const attrs = target.attrs || "";
  return (
    getAttr(attrs, "aria-label") ||
    getAttr(attrs, "title") ||
    getAttr(attrs, "alt") ||
    getAttr(attrs, "name") ||
    getAttr(attrs, "value") ||
    ""
  );
}

function buildPlaywrightLocator(target) {
  const attrs = target.attrs || "";
  const role = inferRole(target);
  const accessibleName = inferAccessibleName(target);
  const label = getAttr(attrs, "aria-label") || getAttr(attrs, "label");
  const placeholder = getAttr(attrs, "placeholder");
  const alt = getAttr(attrs, "alt");
  const title = getAttr(attrs, "title");

  if (role && accessibleName) return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(accessibleName)} })`;
  if (role === "heading") return `page.getByRole("heading")`;
  if (label) return `page.getByLabel(${JSON.stringify(label)})`;
  if (placeholder) return `page.getByPlaceholder(${JSON.stringify(placeholder)})`;
  if (alt) return `page.getByAltText(${JSON.stringify(alt)})`;
  if (title) return `page.getByTitle(${JSON.stringify(title)})`;

  return `page.getByTestId(${JSON.stringify(target.id)})`;
}

function buildPlaywrightAssertions(target, locatorExpr) {
  const attrs = target.attrs || "";
  const { kind } = classifyTarget(target);
  const el = `${locatorExpr}.first()`;
  const lines = [
    `  await expect(${el}).toHaveCount(1);`,
    `  await expect(${el}).toBeAttached();`,
    `  await expect(${el}).toBeVisible();`,
  ];

  const required = hasToken(attrs, "required");
  const disabled = hasToken(attrs, "disabled");
  const checked = hasToken(attrs, "checked");
  const valueAttr = getAttr(attrs, "value");
  const hrefAttr = getAttr(attrs, "href");
  const placeholder = getAttr(attrs, "placeholder");
  const explicitRole = (getAttr(attrs, "role") || "").toLowerCase();
  const classAttr = getAttr(attrs, "class");
  const titleAttr = getAttr(attrs, "title");
  const altAttr = getAttr(attrs, "alt");

  if (required) lines.push(`  await expect(${el}).toHaveAttribute("required", /^(|true|required)$/i);`);
  if (disabled) lines.push(`  await expect(${el}).toBeDisabled();`);
  if (checked && (kind === "checkbox" || kind === "radio")) lines.push(`  await expect(${el}).toBeChecked();`);
  if (valueAttr && (kind === "text" || kind === "maybeText")) lines.push(`  await expect(${el}).toHaveValue(${JSON.stringify(valueAttr)});`);
  if (placeholder) lines.push(`  await expect(${el}).toHaveAttribute("placeholder", ${JSON.stringify(placeholder)});`);
  if (hrefAttr) lines.push(`  await expect(${el}).toHaveAttribute("href", ${JSON.stringify(hrefAttr)});`);
  if (explicitRole) lines.push(`  await expect(${el}).toHaveAttribute("role", ${JSON.stringify(explicitRole)});`);
  if (classAttr) {
    const firstClass = classAttr.trim().split(/\s+/).find(Boolean);
    if (firstClass) lines.push(`  await expect(${el}).toHaveClass(/${escapeRegex(firstClass)}/);`);
  }
  if (titleAttr) lines.push(`  await expect(${el}).toHaveAttribute("title", ${JSON.stringify(titleAttr)});`);
  if (altAttr) lines.push(`  await expect(${el}).toHaveAttribute("alt", ${JSON.stringify(altAttr)});`);

  return lines;
}

function extractDocumentTitle(source) {
  const fromAssign = /document\.title\s*=\s*["'`]([^"'`]+)["'`]/.exec(source);
  if (fromAssign?.[1]) return fromAssign[1].trim();

  const fromTag = /<title[^>]*>([^<]+)<\/title>/i.exec(source);
  if (fromTag?.[1]) return fromTag[1].trim();

  return "";
}

function renderPlaywright(testName, targets, formMode, sourceText) {
  const lines = [];
  const titleHint = extractDocumentTitle(sourceText || "");
  const preAsserts = [];
  const postAsserts = [];
  const actions = [];
  const buttonIds = [];

  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push("");
  lines.push(`test(${JSON.stringify(testName)}, async ({ page }) => {`);
  lines.push(`  await page.goto("/");`);

  if (titleHint) lines.push(`  await expect(page).toHaveTitle(${regexLiteral(titleHint)});`);
  lines.push("");

  if (!targets.length) {
    lines.push(`  await expect(page.locator("body")).toBeVisible();`);
    lines.push("});");
    lines.push("");
    return lines.join("\n");
  }

  for (const target of targets) {
    const { kind, post } = classifyTarget(target);
    const locator = buildPlaywrightLocator(target);
    const assertions = buildPlaywrightAssertions(target, locator);

    if (formMode && post) postAsserts.push(...assertions);
    else preAsserts.push(...assertions);

    if (!formMode) continue;

    if (kind === "text" || kind === "maybeText") actions.push(`  await ${locator}.fill("test");`);
    else if (kind === "select") actions.push(`  await ${locator}.selectOption({ index: 0 });`);
    else if (kind === "checkbox" || kind === "radio") actions.push(`  await ${locator}.check();`);
    else if (kind === "combobox" || kind === "maybeSelect" || kind === "maybeCheckbox" || kind === "maybeRadio") actions.push(`  await ${locator}.click();`);
    else if (kind === "link") actions.push(`  await ${locator}.click();`);
    else if (kind === "button" || kind === "maybeButton") buttonIds.push(target.id);
  }

  lines.push(...preAsserts);

  if (formMode) {
    lines.push("");
    lines.push(...actions);

    const submitId = pickSubmitButton(buttonIds) ?? (buttonIds.at(-1) ?? null);
    if (submitId) lines.push(`  await page.getByTestId(${JSON.stringify(submitId)}).click();`);

    if (postAsserts.length) {
      lines.push("");
      lines.push(...postAsserts);
    }
  }

  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function renderCypress(testName, targets, formMode) {
  const lines = [];
  const preAsserts = [];
  const postAsserts = [];
  const actions = [];
  const buttonIds = [];

  lines.push(`/// <reference types="cypress" />`);
  lines.push("");
  lines.push(`describe(${JSON.stringify(testName)}, () => {`);
  lines.push(`  it("generated", () => {`);
  lines.push(`    cy.visit("/");`);
  lines.push("");

  if (!targets.length) {
    lines.push(`    cy.get("body").should("be.visible");`);
    lines.push("  });");
    lines.push("});");
    lines.push("");
    return lines.join("\n");
  }

  for (const target of targets) {
    const { kind, post } = classifyTarget(target);
    const sel = `[data-testid="${target.id.replace(/"/g, '\\"')}"]`;
    const assertion = `    cy.get(${JSON.stringify(sel)}).should("be.visible");`;

    if (formMode && post) postAsserts.push(assertion);
    else preAsserts.push(assertion);

    if (!formMode) continue;

    if (kind === "text" || kind === "maybeText") actions.push(`    cy.get(${JSON.stringify(sel)}).clear().type("test");`);
    else if (kind === "select") actions.push(`    cy.get(${JSON.stringify(sel)}).select(0);`);
    else if (kind === "checkbox" || kind === "radio") actions.push(`    cy.get(${JSON.stringify(sel)}).check();`);
    else if (kind === "combobox" || kind === "maybeSelect" || kind === "maybeCheckbox" || kind === "maybeRadio") actions.push(`    cy.get(${JSON.stringify(sel)}).click();`);
    else if (kind === "link") actions.push(`    cy.get(${JSON.stringify(sel)}).click();`);
    else if (kind === "button" || kind === "maybeButton") buttonIds.push(target.id);
  }

  lines.push(...preAsserts);

  if (formMode) {
    lines.push("");
    lines.push(...actions);

    const submitId = pickSubmitButton(buttonIds) ?? (buttonIds.at(-1) ?? null);
    if (submitId) {
      const clickSel = `[data-testid="${submitId.replace(/"/g, '\\"')}"]`;
      lines.push(`    cy.get(${JSON.stringify(clickSel)}).click();`);
    }

    if (postAsserts.length) {
      lines.push("");
      lines.push(...postAsserts);
    }
  }

  lines.push("  });");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function generateTestContent(testName, targets, formMode, sourceText) {
  return runner === "cypress"
    ? renderCypress(testName, targets, formMode)
    : renderPlaywright(testName, targets, formMode, sourceText);
}

function processComponent(componentPath) {
  const source = readFile(componentPath);
  const { updated, added } = addMissingTestIds(source, componentPath);

  if (added > 0) fs.writeFileSync(componentPath, updated, "utf8");

  const targets = extractTestIds(updated);
  const base = fileBase(componentPath);
  const testName = `${base} - generated`;
  const ext = runner === "cypress" ? "cy.ts" : "spec.ts";
  const outFile = path.join(outDir, `${toKebab(base)}.${ext}`);

  ensureDir(outDir);
  fs.writeFileSync(outFile, generateTestContent(testName, targets, hasForm(updated), updated), "utf8");

  if (added > 0) process.stdout.write(`Updated: ${componentPath} (${added} data-testid added)\n`);
  process.stdout.write(`Generated: ${outFile}\n`);
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  e2e-testid generate --component src/LoginForm.tsx --runner playwright --out e2e",
      "  e2e-testid generate --dir src/components --runner cypress --out cypress/e2e",
      "  e2e-testid generate --dir src/components --runner playwright --out e2e",
      "",
    ].join("\n")
  );
}

function main() {
  if (cmd !== "generate") {
    printUsage();
    process.exit(0);
  }

  if (!ALLOWED_RUNNERS.has(runner)) {
    process.stderr.write(`Error: unsupported runner "${runner}". Allowed values: "playwright", "cypress".\n`);
    process.exit(1);
  }

  if (inputFile) {
    if (!fs.existsSync(inputFile)) {
      process.stderr.write(`Error: component file not found: ${inputFile}\n`);
      process.exit(1);
    }
    processComponent(inputFile);
    process.exit(0);
  }

  if (inputDir) {
    if (!fs.existsSync(inputDir)) {
      process.stderr.write(`Error: directory not found: ${inputDir}\n`);
      process.exit(1);
    }
    const files = globSync(`${inputDir}/**/*.{ts,tsx,js,jsx}`);
    if (!files.length) {
      process.stderr.write(`Error: no component files found in "${inputDir}"\n`);
      process.exit(1);
    }
    files.forEach(processComponent);
    process.exit(0);
  }

  process.stderr.write("Error: provide --component <file> or --dir <folder>\n");
  printUsage();
  process.exit(1);
}

main();
