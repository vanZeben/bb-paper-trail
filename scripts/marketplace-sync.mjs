#!/usr/bin/env node
// Generate the get-bb/marketplace entry for this plugin from the repository (see docs/RELEASING.md).
//
//   node scripts/marketplace-sync.mjs --tag v0.1.0 --marketplace <checkout> [--repo <dir>] [--dry-run]
//   --repo defaults to the repository this script is in, wherever it is run from.
//
// Prints a JSON summary { id, version, needsPullRequest, reasons, entry } on stdout.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const SOURCE_URL = "https://github.com/vanZeben/bb-paper-trail.git";
const MIN_WIDTH = 1200;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOTS = 6;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Plugin id the way bb derives it from a package name. */
export function derivePluginId(name) {
  let id = String(name).replace(/^@[^/]+\//, "").replace(/^bb-plugin-/, "");
  id = id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return id;
}

/** Default range for a version line. */
export function rangeFor(version) {
  const v = semver.parse(version);
  if (!v) throw new Error(`Not a semantic version: ${version}`);
  return v.major === 0 ? ">=0.1.0 <1.0.0" : `^${v.major}.0.0`;
}

/** Keep the existing range while the version satisfies it. Returns { range, moved }. */
export function chooseRange(version, existingRange) {
  if (existingRange && semver.validRange(existingRange) && semver.satisfies(version, existingRange)) {
    return { range: existingRange, moved: false };
  }
  return { range: rangeFor(version), moved: Boolean(existingRange) };
}

/** Detect image format by magic bytes. */
export function imageFormat(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return undefined;
}

/** Read the pixel width from a PNG, JPEG or WebP header. */
export function imageWidth(buf) {
  const format = imageFormat(buf);
  if (format === "png") {
    if (buf.length < 24) throw new Error("truncated PNG header");
    return buf.readUInt32BE(16);
  }
  if (format === "jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return buf.readUInt16BE(i + 7);
      i += 2 + len;
    }
    throw new Error("no JPEG frame header found");
  }
  if (format === "webp") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) return 1 + buf.readUIntLE(24, 3);
    if (chunk === "VP8L" && buf.length >= 25) return 1 + (buf.readUInt32LE(21) & 0x3fff);
    if (chunk === "VP8 " && buf.length >= 30) return buf.readUInt16LE(26) & 0x3fff;
    throw new Error("unsupported WebP chunk " + chunk);
  }
  throw new Error("not a PNG, JPEG or WebP image");
}

/** Validate one screenshot file; returns a list of problems. */
export function checkScreenshot(name, buf) {
  const problems = [];
  if (!NAME_PATTERN.test(name)) problems.push(`${name}: file name may only use letters, digits, ".", "_" and "-"`);
  if (buf.length > MAX_BYTES) problems.push(`${name}: larger than 2 MiB`);
  const format = imageFormat(buf);
  if (!format) return [...problems, `${name}: not a PNG, JPEG or WebP image (checked by content)`];
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const okExt = format === "jpeg" ? ["jpg", "jpeg"] : [format];
  if (!okExt.includes(ext)) problems.push(`${name}: content is ${format} but the extension is .${ext}`);
  try {
    const width = imageWidth(buf);
    if (width < MIN_WIDTH) problems.push(`${name}: ${width} px wide, at least ${MIN_WIDTH} px required`);
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
  }
  return problems;
}

const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const readIfExists = (path) => (existsSync(path) ? readFileSync(path) : undefined);

/**
 * Build the entry and the file set. Only reads the two directories.
 * Returns { id, version, entry, files: Map<relPath, Buffer>, stale: string[], needsPullRequest, reasons }.
 */
export function plan({ repoDir, marketplaceDir, tag }) {
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  const id = derivePluginId(pkg.name);
  if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Release tag must look like vX.Y.Z, got "${tag}"`);
  const version = tag.slice(1);
  if (version !== pkg.version) throw new Error(`Tag ${tag} does not match package.json version ${pkg.version}`);
  const listing = JSON.parse(readFileSync(join(repoDir, "marketplace", "listing.json"), "utf8"));
  const displayName = pkg.bb?.name;
  if (!displayName) throw new Error("package.json bb.name is missing");
  const prerelease = Boolean(semver.prerelease(version));

  const files = new Map();
  const iconSvg = readFileSync(join(repoDir, "assets", "icon.svg"));
  const iconHash = createHash("sha256").update(iconSvg).digest("hex").slice(0, 8);
  const iconPath = `icons/${id}-${iconHash}.svg`;
  files.set(iconPath, iconSvg);
  const overviewPath = `overview/${id}.md`;
  files.set(overviewPath, readFileSync(join(repoDir, "PLUGIN_OVERVIEW.md")));

  const shotDir = join(repoDir, "marketplace", "screenshots");
  const shots = listFiles(shotDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
  if (shots.length > MAX_SCREENSHOTS) throw new Error(`At most ${MAX_SCREENSHOTS} screenshots allowed, found ${shots.length}`);
  const problems = [];
  const shotRefs = [];
  for (const name of shots) {
    const buf = readFileSync(join(shotDir, name));
    problems.push(...checkScreenshot(name, buf));
    files.set(`screenshots/${id}/${name}`, buf);
    shotRefs.push(`./screenshots/${id}/${name}`);
  }
  if (problems.length) throw new Error("Screenshot problems:\n- " + problems.join("\n- "));

  const entryFile = join(marketplaceDir, "entries", `${id}.json`);
  const existing = existsSync(entryFile) ? JSON.parse(readFileSync(entryFile, "utf8")) : undefined;
  const { range, moved } = chooseRange(version, existing?.source?.git?.range);

  const entry = { id, displayName, description: listing.description, icon: { url: `./${iconPath}` } };
  if (shotRefs.length) entry.screenshots = shotRefs;
  entry.tags = listing.tags;
  entry.author = listing.author;
  if (listing.category) entry.category = listing.category;
  if (listing.secondaryCategories?.length) entry.secondaryCategories = listing.secondaryCategories;
  entry.overview = `./${overviewPath}`;
  entry.source = { git: { url: SOURCE_URL, range } };
  for (const key of ["publishedAt", "updatedAt"]) if (existing?.[key]) entry[key] = existing[key];
  files.set(`entries/${id}.json`, Buffer.from(JSON.stringify(entry, null, 2) + "\n"));

  const stale = [];
  for (const n of listFiles(join(marketplaceDir, "icons"))) {
    if (n.startsWith(`${id}-`) && n.endsWith(".svg") && !files.has(`icons/${n}`)) stale.push(`icons/${n}`);
  }
  for (const n of listFiles(join(marketplaceDir, "screenshots", id))) {
    if (!files.has(`screenshots/${id}/${n}`)) stale.push(`screenshots/${id}/${n}`);
  }

  const reasons = [];
  if (prerelease) {
    reasons.push("pre-release");
  } else if (!existing) {
    reasons.push("first release: the marketplace has no entry yet");
  } else {
    if (moved) reasons.push(`new major version: range ${existing.source?.git?.range} moves to ${range}`);
    const changed = [];
    for (const key of ["displayName", "description", "tags", "category", "secondaryCategories", "author", "screenshots"]) {
      if (JSON.stringify(existing[key]) !== JSON.stringify(entry[key])) changed.push(key);
    }
    for (const [path, buf] of files) {
      if (path === `entries/${id}.json`) continue;
      const current = readIfExists(join(marketplaceDir, path));
      if (!current || !current.equals(buf)) {
        const label = path.startsWith("overview/") ? "overview" : path.startsWith("icons/") ? "icon" : "screenshots";
        if (!changed.includes(label)) changed.push(label);
      }
    }
    if (stale.length && !changed.includes("screenshots") && !changed.includes("icon")) changed.push("removed files");
    if (changed.length) reasons.push(`listing changed: ${changed.join(", ")}`);
  }
  const needsPullRequest = !prerelease && reasons.length > 0;
  return { id, version, entry, files, stale, needsPullRequest, reasons };
}

export function write({ files, stale }, marketplaceDir) {
  for (const path of stale) rmSync(join(marketplaceDir, path), { force: true });
  for (const [path, buf] of files) {
    const target = join(marketplaceDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
  }
}

/** The plugin repository this script belongs to (its parent directory), the default for --repo. */
export const SCRIPT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const out = { repo: SCRIPT_REPO, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--tag") out.tag = argv[++i];
    else if (a === "--marketplace") out.marketplace = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = resolve(args.repo);
  if (!args.marketplace) throw new Error("--marketplace <checkout dir> is required");
  const marketplaceDir = resolve(args.marketplace);
  const tag = args.tag ?? `v${JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version}`;
  const result = plan({ repoDir, marketplaceDir, tag });
  if (!args.dryRun && !semver.prerelease(result.version)) write(result, marketplaceDir);
  const { id, version, needsPullRequest, reasons, entry } = result;
  process.stdout.write(JSON.stringify({ id, version, needsPullRequest, reasons, entry }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`marketplace-sync: ${error.message}\n`);
    process.exit(1);
  }
}
