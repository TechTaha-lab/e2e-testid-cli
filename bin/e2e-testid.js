#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const minimist = require("minimist");
const { globSync } = require("glob");

const args = minimist(process.argv.slice(2));
const cmd = args._[0];

const runner = (args.runner || "playwright").toLowerCase();
const outDir = args.out || "e2e";
const file = args.component;
const dir = args.dir;

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function extractTestIds(source) {
  const ids = new Set();
  const re = /data-testid\s*=\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(source))) ids.add(m[1]);
  return Array.from(ids);
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

function renderPlaywright(testName, testIds) {
  const expects = testIds
    .map((id) => `  await expect(page.getByTestId(${JSON.stringify(id)})).toBeVisible();`)
    .join("\n");
  return `import { test, expect } from "@playwright/test";

test(${JSON.stringify(testName)}, async ({ page }) => {
  await page.goto("/");
${expects ? expects : "  // No data-testid found in source"}
});
`;
}

function renderCypress(testName, testIds) {
  const expects = testIds
    .map((id) => `    cy.get(${JSON.stringify(`[data-testid="${id}"]`)}).should("be.visible");`)
    .join("\n");
  return `describe(${JSON.stringify(testName)}, () => {
  it("renders", () => {
    cy.visit("/");
${expects ? expects : "    // No data-testid found in source"}
  });
});
`;
}

function renderTest(testName, testIds) {
  if (runner === "cypress") return renderCypress(testName, testIds);
  return renderPlaywright(testName, testIds);
}

function writeTestForComponent(componentPath) {
  const source = readText(componentPath);
  const ids = extractTestIds(source);
  const base = fileBase(componentPath);
  const testName = `${base} - generated`;
  const ext = runner === "cypress" ? "cy.ts" : "spec.ts";
  const outFile = path.join(outDir, `${toKebab(base)}.${ext}`);
  ensureDir(outDir);
  fs.writeFileSync(outFile, renderTest(testName, ids), "utf8");
  process.stdout.write(`Generated: ${outFile}\n`);
}

if (cmd !== "generate") {
  process.stdout.write(
    "Usage:\n  e2e-testid generate --component src/LoginForm.tsx --runner playwright --out e2e\n  e2e-testid generate --dir src/components --runner cypress --out cypress/e2e\n"
  );
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
process.exit(1);
