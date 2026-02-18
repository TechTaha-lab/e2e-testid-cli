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
const actions = Boolean(args.actions);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function extractTargets(source) {
  const targets = [];
  const re =
    /<([a-zA-Z0-9_-]+)([^>]*?)data-testid\s*=\s*["'`]([^"'`]+)["'`]([^>]*)>/g;
  let m;
  while ((m = re.exec(source))) {
    const tag = String(m[1]).toLowerCase();
    const id = m[3];
    targets.push({ id, tag });
  }
  const seen = new Set();
  const unique = [];
  for (const t of targets) {
    const k = `${t.tag}:${t.id}`;
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

function renderPlaywright(testName, targets) {
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

  for (const { id, tag } of targets) {
    lines.push(
      `  await expect(page.getByTestId(${JSON.stringify(id)})).toBeVisible();`
    );

    if (actions) {
      if (tag === "button") {
        lines.push(
          `  await page.getByTestId(${JSON.stringify(id)}).click();`
        );
      } else if (tag === "input") {
        lines.push(
          `  await page.getByTestId(${JSON.stringify(id)}).fill("test");`
        );
      } else if (tag === "textarea") {
        lines.push(
          `  await page.getByTestId(${JSON.stringify(id)}).fill("test");`
        );
      } else if (tag === "select") {
        lines.push(
          `  await page.getByTestId(${JSON.stringify(
            id
          )}).selectOption({ index: 0 });`
        );
      }
    }

    lines.push("");
  }

  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function renderCypress(testName, targets) {
  const lines = [];
  lines.push(`describe(${JSON.stringify(testName)}, () => {`);
  lines.push(`  it("renders", () => {`);
  lines.push(`    cy.visit("/");`);
  lines.push("");

  if (!targets.length) {
    lines.push(`    cy.get("body").should("be.visible");`);
    lines.push("  });");
    lines.push("});");
    lines.push("");
    return lines.join("\n");
  }

  for (const { id, tag } of targets) {
    lines.push(
      `    cy.get(${JSON.stringify(
        `[data-testid="${id.replace(/"/g, '\\"')}"]`
      )}).should("be.visible");`
    );

    if (actions) {
      if (tag === "button") {
        lines.push(
          `    cy.get(${JSON.stringify(
            `[data-testid="${id.replace(/"/g, '\\"')}"]`
          )}).click();`
        );
      } else if (tag === "input" || tag === "textarea") {
        lines.push(
          `    cy.get(${JSON.stringify(
            `[data-testid="${id.replace(/"/g, '\\"')}"]`
          )}).clear().type("test");`
        );
      } else if (tag === "select") {
        lines.push(
          `    cy.get(${JSON.stringify(
            `[data-testid="${id.replace(/"/g, '\\"')}"]`
          )}).select(0);`
        );
      }
    }

    lines.push("");
  }

  lines.push("  });");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function renderTest(testName, targets) {
  if (runner === "cypress") return renderCypress(testName, targets);
  return renderPlaywright(testName, targets);
}

function writeTestForComponent(componentPath) {
  const source = readText(componentPath);
  const targets = extractTargets(source);
  const base = fileBase(componentPath);
  const testName = `${base} - generated`;
  const ext = runner === "cypress" ? "cy.ts" : "spec.ts";
  const outFile = path.join(outDir, `${toKebab(base)}.${ext}`);
  ensureDir(outDir);
  fs.writeFileSync(outFile, renderTest(testName, targets), "utf8");
  process.stdout.write(`Generated: ${outFile}\n`);
}

function printUsage() {
  process.stdout.write(
    "Usage:\n  e2e-testid generate --component src/LoginForm.tsx --runner playwright --out e2e\n  e2e-testid generate --dir src/components --runner cypress --out cypress/e2e\n  e2e-testid generate --dir src/components --runner playwright --out e2e --actions\n"
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
