# e2e-testid-cli

CLI tool to automatically generate E2E test templates from `data-testid` usage in your components.

Supports:

* ✅ Playwright
* ✅ Cypress
* ✅ React / TypeScript / JavaScript
* ✅ Batch generation from folders

---

## 🚀 Installation

Install as a dev dependency:

```bash
npm install -D e2e-testid-cli
```

Or use directly with `npx`:

```bash
npx e2e-testid
```

---

## 📦 Usage

### Generate test for a single component

```bash
npx e2e-testid generate \
  --component src/components/LoginForm.tsx \
  --runner playwright \
  --out e2e
```

This will create:

```
e2e/login-form.spec.ts
```

---

### Generate tests for an entire folder

```bash
npx e2e-testid generate \
  --dir src/components \
  --runner playwright \
  --out e2e
```

---

### Generate Cypress tests instead

```bash
npx e2e-testid generate \
  --dir src/components \
  --runner cypress \
  --out cypress/e2e
```

---

## ⚙️ Options

| Option        | Description                          | Required |
| ------------- | ------------------------------------ | -------- |
| `--component` | Path to a single component file      | No       |
| `--dir`       | Directory to scan for components     | No       |
| `--runner`    | `playwright` or `cypress`            | Yes      |
| `--out`       | Output directory for generated tests | Yes      |

You must pass either:

* `--component`
* OR `--dir`

---

## 🧠 How It Works

The CLI scans your component files for:

```jsx
data-testid="some-id"
```

Example component:

```tsx
<input data-testid="Login.Email" />
<button data-testid="Login.Submit" />
```

Generated Playwright test:

```ts
import { test, expect } from "@playwright/test";

test("LoginForm - generated", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("Login.Email")).toBeVisible();
  await expect(page.getByTestId("Login.Submit")).toBeVisible();
});
```

---

## 🛠 Recommended package.json Script

Add this inside your project:

```json
{
  "scripts": {
    "e2e:generate": "e2e-testid generate --dir src/components --runner playwright --out e2e"
  }
}
```

Then run:

```bash
npm run e2e:generate
```

---

## 🔥 Works Perfectly With

* `e2e-testid`
* Playwright
* Cypress
* React
* Next.js
* Vite

---

## 🧩 Example Workflow

1. Add `data-testid` using `e2e-testid` library.
2. Run:

```bash
npm run e2e:generate
```

3. Run your tests:

```bash
npx playwright test
```

---

## 📄 License

ISC


