// Fails when dist/app.js carries zod or the server SDK. Run after a build (npm run check:app).
import { readFileSync } from "node:fs";

const file = new URL("../dist/app.js", import.meta.url);
const text = readFileSync(file, "utf8");
const checks = [
  ["ZodError", /ZodError/],
  ["zod", /\bzod\b/i],
  ["server SDK (@get-bb/plugin-sdk without /app)", /@get-bb\/plugin-sdk"/],
];
const hits = checks.filter(([, re]) => re.test(text)).map(([name]) => name);
if (hits.length > 0) {
  console.error(`dist/app.js is not clean: found ${hits.join(", ")}`);
  process.exit(1);
}
console.log("dist/app.js is clean (no zod, no server SDK).");
