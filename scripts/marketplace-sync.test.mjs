import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRIPT_REPO, checkScreenshot, chooseRange, derivePluginId, imageWidth, parseArgs, plan, rangeFor, write } from "./marketplace-sync.mjs";

const png = (w) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(10, 20);
  return b;
};
const jpeg = (w) => {
  const b = Buffer.alloc(30);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 10], 0);
  b.writeUInt16BE(w, 15);
  return b;
};
const webpX = (w) => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  return b;
};

function fixture({ version = "0.1.0", existing, shots = {}, lateShots = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pt-sync-"));
  const repo = join(root, "repo");
  const mkt = join(root, "mkt");
  for (const d of ["assets", "marketplace/screenshots"]) mkdirSync(join(repo, d), { recursive: true });
  for (const d of ["entries", "icons", "overview"]) mkdirSync(join(mkt, d), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "bb-plugin-paper-trail", version, bb: { name: "Paper Trail" } }));
  writeFileSync(join(repo, "assets/icon.svg"), "<svg/>");
  writeFileSync(join(repo, "PLUGIN_OVERVIEW.md"), "# Paper Trail\n");
  writeFileSync(join(repo, "marketplace/listing.json"), JSON.stringify({ description: "d", tags: ["a"], category: "c", author: { name: "n" } }));
  for (const [n, b] of Object.entries(shots)) writeFileSync(join(repo, "marketplace/screenshots", n), b);
  if (existing) {
    const first = plan({ repoDir: repo, marketplaceDir: mkt, tag: `v${version}` });
    write(first, mkt);
    if (existing !== true) {
      const p = join(mkt, "entries/paper-trail.json");
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...existing }));
    }
  }
  for (const [n, b] of Object.entries(lateShots)) writeFileSync(join(repo, "marketplace/screenshots", n), b);
  return { repo, mkt };
}
const run = (f, tag) => plan({ repoDir: f.repo, marketplaceDir: f.mkt, tag });

describe("plugin id", () => {
  it("strips scope and bb-plugin- prefix, normalises", () => {
    expect(derivePluginId("bb-plugin-paper-trail")).toBe("paper-trail");
    expect(derivePluginId("@vanzeben/bb-plugin-My_Plugin")).toBe("my-plugin");
    expect(derivePluginId("--x.y--")).toBe("x-y");
  });
});

describe("range", () => {
  it("0.x and 1+ defaults", () => {
    expect(rangeFor("0.4.2")).toBe(">=0.1.0 <1.0.0");
    expect(rangeFor("2.3.0")).toBe("^2.0.0");
  });
  it("keeps an existing range the version satisfies", () => {
    expect(chooseRange("1.4.0", "^1.0.0")).toEqual({ range: "^1.0.0", moved: false });
    expect(chooseRange("0.2.0", ">=0.1.0 <1.0.0").moved).toBe(false);
  });
  it("moves on a new major", () => {
    expect(chooseRange("2.0.0", "^1.0.0")).toEqual({ range: "^2.0.0", moved: true });
    expect(chooseRange("1.0.0", ">=0.1.0 <1.0.0")).toEqual({ range: "^1.0.0", moved: true });
  });
});

describe("plan", () => {
  it("first release needs a PR", () => {
    const r = run(fixture(), "v0.1.0");
    expect(r.needsPullRequest).toBe(true);
    expect(r.reasons[0]).toMatch(/first release/);
    expect(r.entry.icon.url).toMatch(/^\.\/icons\/paper-trail-[0-9a-f]{8}\.svg$/);
    expect(r.entry.source.git.range).toBe(">=0.1.0 <1.0.0");
  });
  it("unchanged listing needs no PR", () => {
    const f = fixture({ version: "0.2.0", existing: true });
    const r = run(f, "v0.2.0");
    expect(r.needsPullRequest).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  it("changed listing needs a PR", () => {
    const f = fixture({ version: "0.2.0", existing: { tags: ["old"] } });
    const r = run(f, "v0.2.0");
    expect(r.needsPullRequest).toBe(true);
    expect(r.reasons[0]).toMatch(/tags/);
  });
  it("new major needs a PR", () => {
    const f = fixture({ version: "1.0.0", existing: { source: { git: { url: "u", range: ">=0.1.0 <1.0.0" } } } });
    const r = run(f, "v1.0.0");
    expect(r.needsPullRequest).toBe(true);
    expect(r.entry.source.git.range).toBe("^1.0.0");
    expect(r.reasons[0]).toMatch(/new major/);
  });
  it("pre-release never needs a PR", () => {
    const f = fixture({ version: "1.0.0-beta.1" });
    const r = run(f, "v1.0.0-beta.1");
    expect(r.needsPullRequest).toBe(false);
    expect(r.reasons).toEqual(["pre-release"]);
  });
  it("rejects tag/version mismatch", () => {
    expect(() => run(fixture(), "v0.9.0")).toThrow(/does not match/);
  });
  it("writes files, removes stale icon, and --dry-run style plan writes nothing", () => {
    const f = fixture({ existing: true });
    writeFileSync(join(f.mkt, "icons/paper-trail-deadbeef.svg"), "old");
    const r = run(f, "v0.1.0");
    expect(r.stale).toContain("icons/paper-trail-deadbeef.svg");
    expect(existsSync(join(f.mkt, "icons/paper-trail-deadbeef.svg"))).toBe(true);
    write(r, f.mkt);
    expect(existsSync(join(f.mkt, "icons/paper-trail-deadbeef.svg"))).toBe(false);
  });
  it("adding a screenshot lists it and triggers a PR", () => {
    const f = fixture({ version: "0.2.0", existing: true, lateShots: { "1-a.png": png(1600) } });
    const r = run(f, "v0.2.0");
    expect(r.entry.screenshots).toEqual(["./screenshots/paper-trail/1-a.png"]);
    expect(r.needsPullRequest).toBe(true);
  });
});

describe("image checks", () => {
  it("reads widths from PNG, JPEG and WebP headers", () => {
    expect(imageWidth(png(1280))).toBe(1280);
    expect(imageWidth(jpeg(1500))).toBe(1500);
    expect(imageWidth(webpX(1800))).toBe(1800);
  });
  it("accepts a wide png", () => expect(checkScreenshot("a.png", png(1200))).toEqual([]));
  it("rejects narrow images", () => expect(checkScreenshot("a.png", png(800))[0]).toMatch(/800 px/));
  it("rejects wrong extension, non-images and oversize", () => {
    expect(checkScreenshot("a.jpg", png(1600))[0]).toMatch(/extension/);
    expect(checkScreenshot("a.png", Buffer.from("hello"))[0]).toMatch(/not a PNG/);
    const big = Buffer.concat([png(1600), Buffer.alloc(2 * 1024 * 1024)]);
    expect(checkScreenshot("a.png", big)[0]).toMatch(/2 MiB/);
  });
  it("rejects more than six screenshots", () => {
    const shots = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`${i}.png`, png(1600)]));
    expect(() => run(fixture({ shots }), "v0.1.0")).toThrow(/At most 6/);
  });
});

describe("parseArgs", () => {
  it("defaults --repo to the repository the script is in, not the current directory", () => {
    expect(parseArgs([]).repo).toBe(SCRIPT_REPO);
    expect(JSON.parse(readFileSync(join(SCRIPT_REPO, "package.json"), "utf8")).name).toBe("bb-plugin-paper-trail");
  });
  it("takes --repo, --tag, --marketplace and --dry-run", () => {
    expect(parseArgs(["--repo", "/x", "--tag", "v1.0.0", "--marketplace", "/m", "--dry-run"])).toEqual({ repo: "/x", tag: "v1.0.0", marketplace: "/m", dryRun: true });
  });
  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });
});
