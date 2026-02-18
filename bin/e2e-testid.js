#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const minimist = require("minimist");
const { globSync } = require("glob");

const args = minimist(process.argv.slice(2));
const cmd = args._[0];

const runner = String(args.runner || "playwright").toLowerCase();
const outDir = args.out || "e2e";
const file = args.component;
const dir = args.dir;

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function hasForm(source) {
  return /<form\b[^>]*>/i.test(source) && /<\/form>/i.test(source);
}

function extractTargets(source) {
  const targets = [];
  const re =
    /<([a-zA-Z0-9_-]+)([^>]*?)data-testid\s*=\s*["'`]([^"'`]+)["'`]([^>]*)>/g;
  let m;
  while ((m = re.exec(source))) {
    const rawTag = String(m[1]);
    const tag = rawTag.toLowerCase();
    const id = m[3];
    const attrs = `${m[2] || ""} ${m[4] || ""}`;
    targets.push({ id, tag, rawTag, attrs });
  }
  const seen = new Set();
  const unique = [];
  for (const t of targets) {
    const k = `${t.rawTag}:${t.id}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(t);
    }
  }
  return unique;
}

function toKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function fileBase(filePath) {
  return path.basename(filePath).replace(/\.[^/.]+$/, "");
}

function getAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`, "i");
  const m = re.exec(attrs || "");
  return m ? m[1] : "";
}

function hasToken(s, token) {
  return new RegExp(`\\b${token}\\b`, "i").test(s || "");
}

function isCustomComponent(rawTag) {
  return /^[A-Z]/.test(rawTag || "");
}

function classifyTarget(t) {
  const attrs = t.attrs || "";
  const typeAttr = (getAttr(attrs, "type") || "").toLowerCase();
  const roleAttr = (getAttr(attrs, "role") || "").toLowerCase();
  const asAttr = (getAttr(attrs, "as") || "").toLowerCase();
  const tag = t.tag;

  const effectiveTag =
    asAttr && ["input", "textarea", "select", "button"].includes(asAttr)
      ? asAttr
      : tag;

  const isInputTag = effectiveTag === "input";
  const isTextareaTag = effectiveTag === "textarea";
  const isSelectTag = effectiveTag === "select";
  const isButtonTag = effectiveTag === "button";

  const id = t.id || "";
  const idHint = id.toLowerCase();

  const postSubmitHint = /(success|error|message|toast|alert|result|notice|banner)/i.test(
    idHint
  );

  const isTextboxRole = roleAttr === "textbox" || roleAttr === "searchbox";
  const isButtonRole = roleAttr === "button";
  const isCheckboxRole = roleAttr === "checkbox";
  const isRadioRole = roleAttr === "radio";
  const isComboboxRole = roleAttr === "combobox";

  if (isInputTag) {
    if (typeAttr === "checkbox") return { kind: "checkbox", post: postSubmitHint };
    if (typeAttr === "radio") return { kind: "radio", post: postSubmitHint };
    if (typeAttr === "file") return { kind: "file", post: postSubmitHint };
    if (typeAttr === "submit" || typeAttr === "button") return { kind: "button", post: postSubmitHint };
    return { kind: "text", post: postSubmitHint };
  }

  if (isTextareaTag) return { kind: "text", post: postSubmitHint };
  if (isSelectTag) return { kind: "select", post: postSubmitHint };
  if (isButtonTag) return { kind: "button", post: postSubmitHint };

  if (isButtonRole) return { kind: "button", post: postSubmitHint };
  if (isCheckboxRole) return { kind: "checkbox", post: postSubmitHint };
  if (isRadioRole) return { kind: "radio", post: postSubmitHint };
  if (isTextboxRole) return { kind: "text", post: postSubmitHint };
  if (isComboboxRole) return { kind: "combobox", post: postSubmitHint };

  if (isCustomComponent(t.rawTag)) {
    if (/(input|textfield|textbox|field)/i.test(t.rawTag) || /(input|field|email|password|username|name|search)/i.test(idHint))
      return { kind: "maybeText", post: postSubmitHint };
    if (/(select|dropdown|combobox)/i.test(t.rawTag) || /(select|dropdown|option)/i.test(idHint))
      return { kind: "maybeSelect", post: postSubmitHint };
    if (/(button|btn)/i.test(t.rawTag) || /(submit|save|login|continue|confirm|next)/i.test(idHint))
      return { kind: "maybeButton", post: postSubmitHint };
    if (/(checkbox|check)/i.test(t.rawTag) || /(agree|terms|remember)/i.test(idHint))
      return { kind: "maybeCheckbox", post: postSubmitHint };
    if (/(radio)/i.test(t.rawTag)) return { kind: "maybeRadio", post: postSubmitHint };
  }

  return { kind: "visible", post: postSubmitHint || /^(div|span|p|h[1-6]|section|article)$/i.test(t.tag) };
}

function pickSubmitButton(candidates) {
  if (!candidates.length) return null;
  const score = (id) => {
    const s = (id || "").toLowerCase();
    let v = 0;
    if (/(submit|save|login|sign|confirm|continue|next|send)/i.test(s)) v += 10;
    if (/(cancel|back|close|dismiss)/i.test(s)) v -= 8;
    if (/(button|btn)/i.test(s)) v += 2;
    return v;
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const sc = score(c);
    if (sc > bestScore) {
      best = c;
      bestScore = sc;
    }
  }
  return best;
}

function renderPlaywright(testName, targets, formMode) {
  const lines = [];
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push("");
  lines.push(`test(${JSON.stringify(testName)}, async ({ page }) => {`);
  lines.push(`  await page.goto("/");`);
  lines.push("");

  if (!targets.length) {
    lines.push(`  await expect(page.locator("body")).toBeVisible();`);
    lines.push("});");
    lines.push("");
    return lines.join("\n");
  }

  const preAsserts = [];
  const postAsserts = [];
  const actions = [];
  const buttonIds = [];

  for (const t of targets) {
    const { kind, post } = classifyTarget(t);
    const assertLine = `  await expect(page.getByTestId(${JSON.stringify(t.id)})).toBeVisible();`;

    if (formMode && post) postAsserts.push(assertLine);
    else preAsserts.push(assertLine);

    if (!formMode) continue;

    const loc = `page.getByTestId(${JSON.stringify(t.id)})`;

    if (kind === "text") actions.push(`  await ${loc}.fill("test");`);
    else if (kind === "select") actions.push(`  await ${loc}.selectOption({ index: 0 });`);
    else if (kind === "checkbox") actions.push(`  await ${loc}.check();`);
    else if (kind === "radio") actions.push(`  await ${loc}.check();`);
    else if (kind === "combobox") actions.push(`  await ${loc}.click();`);
    else if (kind === "button") buttonIds.push(t.id);
    else if (kind === "maybeText") actions.push(`  await ${loc}.fill("test");`);
    else if (kind === "maybeSelect") actions.push(`  await ${loc}.click();`);
    else if (kind === "maybeCheckbox") actions.push(`  await ${loc}.click();`);
    else if (kind === "maybeRadio") actions.push(`  await ${loc}.click();`);
    else if (kind === "maybeButton") buttonIds.push(t.id);
  }

  for (const l of preAsserts) lines.push(l);

  if (formMode) {
    lines.push("");
    for (const a of actions) lines.push(a);

    const clickId = pickSubmitButton(buttonIds) || (buttonIds.length ? buttonIds[buttonIds.length - 1] : null);
    if (clickId) lines.push(`  await page.getByTestId(${JSON.stringify(clickId)}).click();`);

    if (postAsserts.length) {
      lines.push("");
      for (const l of postAsserts) lines.push(l);
    }
  }

  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function renderCypress(testName, targets, formMode) {
  const lines = [];
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

  const preAsserts = [];
  const postAsserts = [];
  const actions = [];
  const buttonIds = [];

  for (const t of targets) {
    const { kind, post } = classifyTarget(t);
    const sel = `[data-testid="${t.id.replace(/"/g, '\\"')}"]`;
    const assertLine = `    cy.get(${JSON.stringify(sel)}).should("be.visible");`;

    if (formMode && post) postAsserts.push(assertLine);
    else preAsserts.push(assertLine);

    if (!formMode) continue;

    if (kind === "text") actions.push(`    cy.get(${JSON.stringify(sel)}).clear().type("test");`);
    else if (kind === "select") actions.push(`    cy.get(${JSON.stringify(sel)}).select(0);`);
    else if (kind === "checkbox") actions.push(`    cy.get(${JSON.stringify(sel)}).check();`);
    else if (kind === "radio") actions.push(`    cy.get(${JSON.stringify(sel)}).check();`);
    else if (kind === "combobox") actions.push(`    cy.get(${JSON.stringify(sel)}).click();`);
    else if (kind === "button") buttonIds.push(t.id);
    else if (kind === "maybeText") actions.push(`    cy.get(${JSON.stringify(sel)}).type("test");`);
    else if (kind === "maybeSelect") actions.push(`    cy.get(${JSON.stringify(sel)}).click();`);
    else if (kind === "maybeCheckbox") actions.push(`    cy.get(${JSON.stringify(sel)}).click();`);
    else if (kind === "maybeRadio") actions.push(`    cy.get(${JSON.stringify(sel)}).click();`);
    else if (kind === "maybeButton") buttonIds.push(t.id);
  }

  for (const l of preAsserts) lines.push(l);

  if (formMode) {
    lines.push("");
    for (const a of actions) lines.push(a);

    const clickId = pickSubmitButton(buttonIds) || (buttonIds.length ? buttonIds[buttonIds.length - 1] : null);
    if (clickId) {
      const clickSel = `[data-testid="${clickId.replace(/"/g, '\\"')}"]`;
      lines.push(`    cy.get(${JSON.stringify(clickSel)}).click();`);
    }

    if (postAsserts.length) {
      lines.push("");
      for (const l of postAsserts) lines.push(l);
    }
  }

  lines.push("  });");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function renderTest(testName, targets, formMode) {
  if (runner === "cypress") return renderCypress(testName, targets, formMode);
  return renderPlaywright(testName, targets, formMode);
}

function writeTestForComponent(componentPath) {
  const source = readText(componentPath);
  const targets = extractTargets(source);
  const base = fileBase(componentPath);
  const testName = `${base} - generated`;
  const ext = runner === "cypress" ? "cy.ts" : "spec.ts";
  const outFile = path.join(outDir, `${toKebab(base)}.${ext}`);
  ensureDir(outDir);
  fs.writeFileSync(outFile, renderTest(testName, targets, hasForm(source)), "utf8");
  process.stdout.write(`Generated: ${outFile}\n`);
}

function printUsage() {
  process.stdout.write(
    "Usage:\n  e2e-testid generate --component src/LoginForm.tsx --runner playwright --out e2e\n  e2e-testid generate --dir src/components --runner cypress --out cypress/e2e\n  e2e-testid generate --dir src/components --runner playwright --out e2e\n"
  );
}

if (cmd !== "generate") {
  printUsage();
  process.exit(0);
}

if (file) {
  writeTestForComponent(file);
  process.exit(0);
}

if (dir) {
  const files = globSync(`${dir}/**/*.{ts,tsx,js,jsx}`);
  files.forEach(writeTestForComponent);
  process.exit(0);
}

process.stderr.write("Error: pass --component <file> or --dir <folder>\n");
printUsage();
process.exit(1);
