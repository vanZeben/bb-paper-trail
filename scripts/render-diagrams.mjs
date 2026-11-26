#!/usr/bin/env node
// Renders the documentation images to docs/assets/: hero.svg and diagrams/*.svg, and, when a rasteriser is
// available, social-preview.png.
//
// Everything is plain SVG (shapes and text, no foreignObject, no scripts, no external fonts) so it shows on GitHub web
// and mobile, in light and dark mode, and anywhere else a README renders. Each image paints its own dark background.
// All data in the hero is fictional. The grid colours are the plugin's real rating palette (components/graph/helpers.ts).
//
// Edit a layout below, then run: node scripts/render-diagrams.mjs
//
// The PNG is optional: it needs the `sharp` package (libvips with librsvg). It is looked up in ./node_modules, then at
// the path in $SHARP_PATH. If neither exists the PNG step is skipped and the existing file, if any, is left alone.
// (For the PNG the middle dot and ellipsis are swapped for | and ... because some fallback fonts lack them.)
// Note that PNG text is drawn with whatever sans-serif font the machine has; run it on a machine with Inter or
// Helvetica-class fonts for the best result.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "docs", "assets");
const OUT = join(ASSETS, "diagrams");

const C = {
  bg0: "#0b1214", bg1: "#14201f", panel: "#101a1a", edge: "#263534",
  node: "#182524", nodeStroke: "#2e4140", text: "#e8f0ee", muted: "#8fa6a2", faint: "#6f8581",
  line: "#56706c", accent: "#2fd0b4", accentText: "#04201b", warn: "#e5a23c",
  paper: "#f3eee0", ink: "#1b2826",
};
// Rating palette, copied from components/graph/helpers.ts (RATING_COLOR). Empty = the "muted" cell.
const RATING = { exceeds: "#a3e635", meets: "#15803d", needs_improvement: "#f97316", none: "#243231" };
const MARK = { hit: "#4ade80", partial: "#fbbf24", missed: "#fb923c" };
const FONT = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function doc(w, h, title, desc, body, extraDefs = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
  <title id="t">${esc(title)}</title>
  <desc id="d">${esc(desc)}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.line}"/></marker>
    <marker id="arrowA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.accent}"/></marker>${extraDefs}
  </defs>
  <rect width="${w}" height="${h}" rx="20" fill="url(#bg)"/>
  <g font-family="${FONT}">
${body}
  </g>
</svg>
`;
}

/** Multi-line text, vertically centred on y; lines split on "\n". */
function text(x, y, label, { size = 15, weight = 400, fill = C.text, anchor = "middle", lh = 1.3, family } = {}) {
  const lines = String(label).split("\n");
  const top = y - ((lines.length - 1) * size * lh) / 2;
  const fam = family ? ` font-family="${family}"` : "";
  return lines
    .map((l, i) => `    <text x="${x}" y="${(top + i * size * lh + size * 0.36).toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${fam}>${esc(l)}</text>`)
    .join("\n");
}

/** Node kinds: box, decision (teal left rule), pill, accent (teal fill), warn (amber rule, third-party text), dashed. */
function node(n) {
  const { x, y, w, h, kind = "box", label, size = 15 } = n;
  const left = x - w / 2, top = y - h / 2;
  if (kind === "pill" || kind === "accent") {
    const fill = kind === "accent" ? C.accent : C.node;
    const stroke = kind === "accent" ? C.accent : C.nodeStroke;
    return `    <rect x="${left}" y="${top}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}"/>\n` +
      text(x, y, label, { size, weight: 600, fill: kind === "accent" ? C.accentText : C.text });
  }
  const dash = kind === "dashed" ? ` stroke-dasharray="5 4"` : "";
  const out = [`    <rect x="${left}" y="${top}" width="${w}" height="${h}" rx="12" fill="${C.node}" stroke="${C.nodeStroke}"${dash}/>`];
  if (kind === "decision") out.push(`    <rect x="${left}" y="${top + 10}" width="4" height="${h - 20}" rx="2" fill="${C.accent}"/>`);
  if (kind === "warn") out.push(`    <rect x="${left}" y="${top + 10}" width="4" height="${h - 20}" rx="2" fill="${C.warn}"/>`);
  out.push(text(x, y, label, { size }));
  return out.join("\n");
}

/** Edge through waypoints, optional label at a point. */
function edge(points, { label, at, accent = false, dashed = false, labelAnchor = "middle" } = {}) {
  const d = points.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
  const stroke = accent ? C.accent : C.line;
  let s = `    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" ${dashed ? 'stroke-dasharray="6 5" ' : ""}stroke-linejoin="round" marker-end="url(#${accent ? "arrowA" : "arrow"})"/>`;
  if (label) {
    const [lx, ly] = at ?? points[0];
    s += `\n    <text x="${lx}" y="${ly}" font-size="13" font-weight="600" fill="${C.muted}" text-anchor="${labelAnchor}">${esc(label)}</text>`;
  }
  return s;
}

const heading = (x, y, s, fill = C.muted) => `    <text x="${x}" y="${y}" font-size="13" font-weight="600" fill="${fill}" letter-spacing="1.6">${esc(s.toUpperCase())}</text>`;
const side = (n, s) => ({ l: [n.x - n.w / 2, n.y], r: [n.x + n.w / 2, n.y], t: [n.x, n.y - n.h / 2], b: [n.x, n.y + n.h / 2] })[s];
const group = (x, y, w, h, title, { stroke = C.edge, dashed = false, titleFill = C.muted } = {}) =>
  `    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.panel}" stroke="${stroke}"${dashed ? ` stroke-dasharray="7 5"` : ""}/>\n${heading(x + 20, y + 30, title, titleFill)}`;
const box = (x, y, w, h, label, kind = "box", size = 15) => node({ x: x + w / 2, y: y + h / 2, w, h, label, kind, size });
const note = (x, y, s, { size = 13, fill = C.faint, anchor = "middle" } = {}) =>
  String(s).split("\n").map((l, i) => `    <text x="${x}" y="${y + i * size * 1.3}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(l)}</text>`).join("\n");

/** The Paper Trail mark: a receipt with a torn edge, a rising line on it and a check at the end. */
function mark(x, y, s = 1) {
  return `    <g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 2h40a2 2 0 0 1 2 2v54l-5-4-5 4-5-4-5 4-5-4-5 4-5-4-5 4-5-4V4a2 2 0 0 1 2-2z" fill="#14201f" stroke="${C.accent}" stroke-width="3"/>
      <path d="M12 38l8-8 7 5 10-13" stroke="#f0f6f4" stroke-width="3"/>
      <circle cx="37" cy="22" r="3.4" fill="${C.accent}" stroke="none"/>
      <path d="M12 46h14" stroke="${C.line}" stroke-width="3"/>
    </g>`;
}

// ---------------------------------------------------------------------------
// 1. Hero.

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mark chip with a drawn icon (no glyph fonts needed): hit = check, partial = half circle, missed = cross. */
function markChip(x, y, kind) {
  const col = MARK[kind], label = { hit: "Hit", partial: "Partial", missed: "Missed" }[kind];
  const w = kind === "partial" ? 78 : 66, h = 26;
  const cx = x + 15, cy = y + h / 2;
  const icon = {
    hit: `<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="${col}" stroke-width="2"/><path d="M${cx - 3.5} ${cy}l2.5 3 4.5-5.5" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    partial: `<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="${col}" stroke-width="2"/><path d="M${cx} ${cy - 8}a8 8 0 0 1 0 16z" fill="${col}"/>`,
    missed: `<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="${col}" stroke-width="2"/><path d="M${cx - 3.2} ${cy - 3.2}l6.4 6.4M${cx + 3.2} ${cy - 3.2}l-6.4 6.4" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"/>`,
  }[kind];
  return `    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-opacity="0.5"/>\n    ${icon}\n` +
    `    <text x="${x + 28}" y="${y + 18}" font-size="13.5" font-weight="600" fill="${col}">${label}</text>`;
}

function hero() {
  const W = 1280, H = 640;
  const parts = [];

  // Title block.
  parts.push(mark(48, 40, 1.1));
  parts.push(`    <text x="112" y="88" font-size="52" font-weight="700" fill="#f0f6f4" letter-spacing="-1">Paper Trail</text>`);
  parts.push(`    <text x="50" y="140" font-size="26" fill="#cfe0dc">Every claim has a receipt.</text>`);
  parts.push(`    <text x="50" y="178" font-size="16" fill="${C.muted}">A private, evidence-backed contribution graph for your review conversations.</text>`);

  // Graph panel.
  const PX = 48, PY = 206, PW = 760, PH = 394;
  parts.push(`    <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="18" fill="${C.panel}" stroke="${C.edge}"/>`);
  // Lens tabs.
  const lenses = [["Rating", 82], ["Area", 62], ["Meetings", 94], ["Evidence", 92], ["Plan", 58]];
  let lx = PX + 24;
  lenses.forEach(([label, w], i) => {
    const on = i === 0;
    parts.push(`    <rect x="${lx}" y="${PY + 18}" width="${w}" height="28" rx="14" fill="${on ? C.accent : C.node}" stroke="${on ? C.accent : C.nodeStroke}"/>`);
    parts.push(text(lx + w / 2, PY + 32, label, { size: 14, weight: 600, fill: on ? C.accentText : C.muted }));
    lx += w + 8;
  });

  // Grid: 24 weeks (24..47) x Mon-Fri.
  const WEEKS = 24, FIRST = 24, CELL = 23, PITCH = 28;
  const gx = PX + 58, gy = PY + 104;
  const rand = mulberry32(47);
  const weeks = [];
  for (let w = 0; w < WEEKS; w++) {
    const days = [];
    for (let d = 0; d < 5; d++) {
      let r = rand() + 0.13 * Math.sin(w * 0.6 + d * 0.3);
      let v = r < 0.05 ? "none" : r < 0.17 ? "needs_improvement" : r < 0.8 ? "meets" : "exceeds";
      if (w === 8) v = d === 0 ? "meets" : "none"; // a week away
      if (w === 9) v = "none";
      days.push(v);
    }
    weeks.push(days);
  }
  weeks[WEEKS - 1] = ["meets", "exceeds", "exceeds", "meets", "exceeds"]; // week 47, the selected one
  const SEL = WEEKS - 1;
  const weekRating = (days) => {
    const s = days.filter((v) => v !== "none");
    if (s.length < 3) return "none";
    const score = s.reduce((a, v) => a + (v === "exceeds" ? 1 : v === "meets" ? 0 : -1), 0) / s.length;
    return score > 0.25 ? "exceeds" : score < -0.2 ? "needs_improvement" : "meets";
  };
  const months = [[0, "Jun"], [4, "Jul"], [8, "Aug"], [13, "Sep"], [17, "Oct"], [22, "Nov"]];
  for (const [i, m] of months) parts.push(`    <text x="${gx + i * PITCH}" y="${gy - 24}" font-size="12.5" fill="${C.muted}">${m}</text>`);
  ["M", "T", "W", "T", "F"].forEach((l, d) => parts.push(`    <text x="${gx - 14}" y="${gy + d * PITCH + 16}" font-size="12.5" fill="${C.muted}" text-anchor="end">${l}</text>`));
  // selected column highlight
  const sx = gx + SEL * PITCH;
  parts.push(`    <rect x="${sx - 5}" y="${gy - 17}" width="${CELL + 10}" height="${4 * PITCH + CELL + 22}" rx="8" fill="${C.accent}" fill-opacity="0.1" stroke="${C.accent}" stroke-width="1.5"/>`);
  weeks.forEach((days, w) => {
    const x = gx + w * PITCH;
    const wr = weekRating(days);
    if (wr !== "none") parts.push(`    <rect x="${x}" y="${gy - 11}" width="${CELL}" height="3" rx="1.5" fill="${RATING[wr]}"/>`);
    days.forEach((v, d) => {
      const y = gy + d * PITCH;
      parts.push(`    <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="4" fill="${RATING[v]}"/>`);
    });
  });
  // "you changed the AI's rating" corner marks (real UI glyph), on two cells.
  for (const [w, d] of [[14, 2], [20, 3]]) {
    const x = gx + w * PITCH + CELL - 7, y = gy + d * PITCH;
    parts.push(`    <path d="M${x} ${y}h7v7z" fill="#f0f6f4"/>`);
  }
  // selected week label
  parts.push(`    <rect x="${sx - 4}" y="${gy - 40}" width="${CELL + 8}" height="18" rx="5" fill="#f0f6f4"/>`);
  parts.push(`    <text x="${sx + CELL / 2}" y="${gy - 27}" font-size="12" font-weight="700" fill="${C.ink}" text-anchor="middle">47</text>`);

  // Legend, under the grid on the left.
  const ly = gy + 4 * PITCH + CELL + 34;
  const legend = [["exceeds", "Exceeds"], ["meets", "Meets"], ["needs_improvement", "Needs improvement"], ["none", "No data"]];
  legend.forEach(([k, label], i) => {
    const y = ly + i * 25;
    parts.push(`    <rect x="${PX + 28}" y="${y - 10}" width="14" height="14" rx="3" fill="${RATING[k]}"/>`);
    parts.push(`    <text x="${PX + 52}" y="${y + 2}" font-size="13.5" fill="#cfe0dc">${label}</text>`);
  });
  parts.push(`    <path d="M${PX + 28} ${ly + 4 * 25 - 10}h7v7z" fill="#f0f6f4"/>`);
  parts.push(`    <text x="${PX + 52}" y="${ly + 4 * 25 + 2}" font-size="13.5" fill="#cfe0dc">You changed the rating</text>`);

  // Popover: a receipt for the selected week, torn along the bottom edge.
  const pw = 300, ph = 146, px = PX + PW - 24 - pw, py = ly - 28;
  const teeth = 15, tw = pw / teeth;
  let zig = `M${px} ${py}h${pw}v${ph - 8}`;
  for (let i = 0; i < teeth; i++) zig += `l${-tw / 2} 8l${-tw / 2} -8`;
  zig += "z";
  const notchX = sx + CELL / 2;
  parts.push(`    <path d="M${notchX - 8} ${py}l8 -9l8 9z" fill="${C.paper}"/>`);
  parts.push(`    <path d="${zig}" fill="${C.paper}"/>`);
  parts.push(`    <circle cx="${px + 22}" cy="${py + 25}" r="6" fill="${RATING.exceeds}" stroke="${C.ink}" stroke-opacity="0.35"/>`);
  parts.push(`    <text x="${px + 36}" y="${py + 30}" font-size="16" font-weight="700" fill="${C.ink}">Week 47 · Exceeds</text>`);
  parts.push(`    <path d="M${px + 16} ${py + 42}h${pw - 32}" stroke="${C.ink}" stroke-opacity="0.35" stroke-dasharray="3 4"/>`);
  parts.push(`    <text x="${px + 18}" y="${py + 64}" font-size="14.5" fill="${C.ink}">3 shipped · 2 decisions · 1 unblock</text>`);
  parts.push(`    <text x="${px + 18}" y="${py + 87}" font-size="12" font-weight="600" fill="#4a5c58" letter-spacing="1">EVIDENCE</text>`);
  [["H1109-2", 0], ["H1109-7", 80], ["H1112-1", 160]].forEach(([id, dx]) => {
    parts.push(`    <rect x="${px + 18 + dx}" y="${py + 94}" width="72" height="22" rx="5" fill="${C.ink}" fill-opacity="0.1"/>`);
    parts.push(`    <text x="${px + 54 + dx}" y="${py + 109}" font-size="12.5" fill="${C.ink}" text-anchor="middle" font-family="${MONO}">${id}</text>`);
  });
  parts.push(`    <text x="${px + 262}" y="${py + 109}" font-size="14" fill="${C.ink}" text-anchor="start">…</text>`);
  parts.push(`    <text x="${px + 18}" y="${py + 138}" font-size="12.5" fill="#4a5c58">Each id links to its source.</text>`);

  // Side panel: the week plan.
  const SX = 836, SY = 40, SW = 396, SH = 560;
  parts.push(`    <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="18" fill="${C.panel}" stroke="${C.edge}"/>`);
  parts.push(heading(SX + 24, SY + 36, "Week 47 · Intent"));
  parts.push(text(SX + 24, SY + 68, "Land the billing migration and clear\nthe blockers on the mobile release.", { size: 16, anchor: "start", lh: 1.35 }));
  parts.push(`    <path d="M${SX + 24} ${SY + 104}h${SW - 48}" stroke="${C.edge}"/>`);
  parts.push(heading(SX + 24, SY + 134, "Commitments · done when"));
  const items = [
    ["hit", "Ship billing migration", "Done when: cutover merged, no rollback"],
    ["hit", "Decide on the queue vendor", "Done when: decision doc approved"],
    ["partial", "Unblock the mobile release", "Done when: build is in store review"],
    ["missed", "Draft the Q1 capacity plan", "Done when: plan circulated to leads"],
  ];
  items.forEach(([k, t, d], i) => {
    const y = SY + 152 + i * 62;
    parts.push(markChip(SX + 24, y + 4, k));
    parts.push(`    <text x="${SX + 112}" y="${y + 19}" font-size="15.5" font-weight="600" fill="${C.text}">${esc(t)}</text>`);
    parts.push(`    <text x="${SX + 112}" y="${y + 40}" font-size="13" fill="${C.muted}">${esc(d)}</text>`);
  });
  // Accuracy trend.
  const ty = SY + 152 + 4 * 62 + 14;
  parts.push(`    <path d="M${SX + 24} ${ty - 12}h${SW - 48}" stroke="${C.edge}"/>`);
  parts.push(heading(SX + 24, ty + 18, "Plan accuracy · last 8 weeks"));
  const acc = [50, 58, 54, 66, 62, 74, 70, 75];
  acc.forEach((a, i) => {
    const bh = (a / 100) * 62, bx = SX + 24 + i * 24, by = ty + 100 - bh;
    parts.push(`    <rect x="${bx}" y="${by}" width="18" height="${bh.toFixed(1)}" rx="3" fill="${C.accent}" fill-opacity="${i === acc.length - 1 ? 1 : 0.45}"/>`);
  });
  parts.push(`    <text x="${SX + 24 + 8 * 24 + 8}" y="${ty + 70}" font-size="28" font-weight="700" fill="${C.text}">75%</text>`);
  parts.push(`    <text x="${SX + 24 + 8 * 24 + 8}" y="${ty + 92}" font-size="13" fill="${C.muted}">hit rate, trending up</text>`);

  return doc(W, H, "Paper Trail: every claim has a receipt",
    "Paper Trail is a private, evidence-backed contribution graph of your engineering work, for performance-review conversations. The picture shows a grid of weeks by weekdays coloured by day rating (exceeds, meets, needs improvement, no data), a selected week 47 with a receipt-style popover reading Exceeds, 3 shipped, 2 decisions and evidence ids, and a side panel with the week's intent and four commitments marked Hit, Hit, Partial and Missed, with a plan-accuracy trend. All data is fictional.",
    parts.join("\n"));
}

// ---------------------------------------------------------------------------
// 2. Pipeline: from connectors to the graph.

function pipeline() {
  const W = 1340, H = 520, cy = 262;
  const parts = [heading(48, 44, "From your connectors to your graph")];
  // Connectors group.
  const names = ["Calendar", "Meeting notes", "Tracker", "Docs", "Code", "Chat", "Notes", "Memory"];
  parts.push(group(40, 80, 260, 360, "Your connectors"));
  names.forEach((n, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    parts.push(box(58 + col * 118, 122 + row * 76, 106, 56, n, "box", 14));
  });
  parts.push(note(170, 428, "read-only access, held by your agent", { size: 12.5 }));
  // The chain.
  const bw = 148, bh = 108;
  const xs = [340, 524, 708, 892].map((x) => x + bw / 2);
  const chain = [
    { label: "Hidden capture\nthreads\non your host", cap: "auto · read tools", kind: "decision" },
    { label: "Evidence\nids + links", cap: "every item cites a source", kind: "box" },
    { label: "Day rating", cap: "no tools · accept-edits", kind: "box" },
    { label: "Friday\njudgment", cap: "week vs. its commitments", kind: "box" },
  ];
  const nodes = chain.map((c, i) => ({ x: xs[i], y: cy, w: bw, h: bh, label: c.label, kind: c.kind }));
  parts.push(edge([[302, cy], [338, cy]], { accent: true }));
  nodes.slice(1).forEach((n, i) => parts.push(edge([side(nodes[i], "r"), side(n, "l")])));
  nodes.forEach((n) => parts.push(node(n)));
  chain.forEach((c, i) => parts.push(note(xs[i], cy + bh / 2 + 26, c.cap, { size: 12.5 })));
  // Outputs group.
  parts.push(edge([[1040, cy], [1076, cy]], { accent: true }));
  parts.push(group(1078, 140, 216, 244, "You get"));
  ["Graph", "Review packet", "Threads", "Invisible-work radar"].forEach((n, i) => parts.push(box(1096, 180 + i * 49, 180, 40, n, "pill", 14)));
  // Footer.
  parts.push(`    <rect x="40" y="466" width="1260" height="34" rx="17" fill="${C.node}" stroke="${C.nodeStroke}"/>`);
  parts.push(text(670, 483, "The plugin holds no credentials: capture uses your own agent's connectors, and everything it stores stays in the local plugin database.", { size: 14, fill: C.muted }));
  return doc(W, H, "Paper Trail pipeline",
    "Your agent's connectors (calendar, meeting notes, tracker, docs, code, chat, notes, memory) are read by hidden capture threads on your host. Capture produces evidence with ids and links. Evidence feeds a day rating, then a Friday judgment. The results appear as the contribution graph, the review packet, threads with closure notes and the invisible-work radar. The plugin holds no credentials.",
    parts.join("\n"));
}

// 3. Week loop.

function weekLoop() {
  const W = 1280, H = 560, R1 = 160, R2 = 340, bw = 236, bh = 80;
  const n = {
    role: { x: 150, y: R1, w: bw, h: bh, kind: "pill", label: "Role card" },
    goals: { x: 450, y: R1, w: bw, h: bh, label: "Goals\ninferred from the role card" },
    tasks: { x: 750, y: R1, w: bw, h: bh, label: "Goal tasks\nbacklog + suggested" },
    scan: { x: 1050, y: R1, w: bw, h: bh + 10, kind: "decision", label: "Monday week scan\ncalendar + backlog +\nlast week's marks" },
    cal: { x: 1050, y: 66, w: 150, h: 34, kind: "pill", label: "This week's calendar" },
    intent: { x: 1050, y: R2, w: bw, h: bh + 10, label: "Week intent +\ncommitments,\neach with a done-when" },
    judge: { x: 750, y: R2, w: bw, h: bh, kind: "decision", label: "Friday judge\nevidence vs. each\ncommitment" },
    marks: { x: 450, y: R2, w: bw, h: bh, label: "Marks\nhit · partial · missed" },
    retro: { x: 150, y: R2, w: bw, h: bh + 10, kind: "accent", label: "Retro +\naccuracy trend" },
  };
  const loopY = 470;
  const e = [
    edge([side(n.role, "r"), side(n.goals, "l")]),
    edge([side(n.goals, "r"), side(n.tasks, "l")]),
    edge([side(n.tasks, "r"), side(n.scan, "l")]),
    edge([side(n.cal, "b"), side(n.scan, "t")]),
    edge([side(n.scan, "b"), side(n.intent, "t")]),
    edge([side(n.intent, "l"), side(n.judge, "r")], { label: "all week", at: [900, R2 - 12] }),
    edge([side(n.judge, "l"), side(n.marks, "r")]),
    edge([side(n.marks, "l"), side(n.retro, "r")]),
    edge([side(n.retro, "b"), [150, loopY], [1226, loopY], [1226, R1], side(n.scan, "r")], { accent: true }),
    `    <text x="690" y="${loopY - 12}" font-size="14" font-weight="600" fill="${C.accent}" text-anchor="middle">Back into next Monday's scan</text>`,
    note(690, loopY + 26, "Last week's marks and the accuracy trend shape the next week's intent.", { size: 13 }),
  ];
  const body = [heading(48, 44, "The weekly loop"), ...e, ...Object.values(n).map(node)].join("\n");
  return doc(W, H, "The Paper Trail weekly loop",
    "The role card yields goals, and goals yield goal tasks (backlog plus suggested). On Monday the week scan combines this week's calendar, the backlog and last week's marks into a week intent and commitments, each with a done-when mark. On Friday the judge scores each commitment hit, partial or missed from the week's evidence, writes a retro and updates the accuracy trend. Those feed back into the next Monday's scan.",
    body);
}

// 4. Setup.

function setup() {
  const W = 1280, H = 540;
  const parts = [heading(48, 44, "Setup: three fields and one button")];
  parts.push(group(40, 80, 250, 280, "You give"));
  ["Role card", "Name", "Email"].forEach((s, i) => parts.push(box(60, 122 + i * 74, 210, 56, s, "pill")));
  const fig = { x: 400, y: 220, w: 170, h: 120 };
  parts.push(edge([[292, 220], [313, 220]]));
  parts.push(`    <rect x="${fig.x - fig.w / 2}" y="${fig.y - fig.h / 2}" width="${fig.w}" height="${fig.h}" rx="16" fill="${C.accent}"/>`);
  parts.push(text(fig.x, fig.y - 12, "Figure it out", { size: 19, weight: 700, fill: C.accentText }));
  parts.push(text(fig.x, fig.y + 22, "an agent with\nread tools", { size: 14, fill: C.accentText }));
  parts.push(edge([[486, 220], [548, 220]], { accent: true }));
  parts.push(group(550, 80, 300, 360, "It infers"));
  [["Framework", "role areas and what good looks like"], ["Work split", "how your time divides"], ["Guardrails", "what to flag, and when"], ["Goals → tasks", "a starting backlog"]].forEach(([a, b], i) => {
    const y = 122 + i * 78;
    parts.push(box(570, y, 260, 64, "", "decision"));
    parts.push(`    <text x="590" y="${y + 27}" font-size="15.5" font-weight="600" fill="${C.text}">${a}</text>`);
    parts.push(`    <text x="590" y="${y + 48}" font-size="13" fill="${C.muted}">${b}</text>`);
  });
  parts.push(edge([[852, 260], [912, 260]], { accent: true }));
  parts.push(group(914, 80, 326, 360, "Then"));
  parts.push(box(934, 122, 286, 80, "Applied automatically\nno approval step", "box"));
  parts.push(edge([[1077, 204], [1077, 238]]));
  parts.push(box(934, 240, 286, 100, "“Here's what I figured out”\na summary of what was set,\nwith an Edit link on each part", "decision"));
  parts.push(note(1077, 372, "Edit anything, any time.", { size: 13.5, fill: C.muted }));
  // Re-run loop.
  parts.push(edge([[1077, 342], [1077, 470], [400, 470], [400, 282]], { dashed: true, accent: true }));
  parts.push(`    <rect x="560" y="454" width="300" height="32" rx="16" fill="${C.node}" stroke="${C.accent}"/>`);
  parts.push(text(710, 470, "Re-runs keep your edits", { size: 14.5, weight: 600 }));
  parts.push(note(710, 508, "Run “Figure it out” again after a role change; what you edited stays as you set it.", { size: 13 }));
  return doc(W, H, "Paper Trail setup",
    "You enter a role card, your name and your email, then press Figure it out. An agent with read tools infers the framework of role areas, the work split, the guardrails and the goals with their tasks. They are applied automatically, then a summary titled Here's what I figured out is shown with an Edit link on each part. Re-running Figure it out keeps the edits you made.",
    parts.join("\n"));
}

// 5. Security.

function security() {
  const W = 1280, H = 600;
  const parts = [heading(48, 44, "Trust boundaries")];
  // Third-party text.
  parts.push(group(40, 90, 240, 360, "Not trusted", { stroke: C.warn, titleFill: C.warn }));
  ["Ticket and PR text", "Meeting notes\nand chat", "Docs and\ncode comments"].forEach((s, i) => parts.push(box(60, 136 + i * 92, 200, 72, s, "warn")));
  parts.push(note(160, 424, "third-party words, never instructions", { size: 12.5 }));
  // Agent + fence.
  parts.push(group(330, 90, 440, 366, "Your agent, on your host"));
  parts.push(`    <rect x="350" y="124" width="400" height="316" rx="12" fill="none" stroke="${C.warn}" stroke-width="1.5" stroke-dasharray="7 5"/>`);
  parts.push(`    <text x="366" y="147" font-size="12.5" font-weight="600" fill="${C.warn}" letter-spacing="1.2">EVIDENCE FENCE · RANDOM PER PROMPT</text>`);
  const capN = { x: 550, y: 218, w: 360, h: 98, kind: "decision", label: "" };
  const rateN = { x: 550, y: 372, w: 360, h: 98, kind: "decision", label: "" };
  parts.push(node(capN), node(rateN));
  parts.push(`    <text x="378" y="203" font-size="16" font-weight="600" fill="${C.text}">Capture jobs</text>`);
  parts.push(`    <text x="378" y="226" font-size="13.5" fill="${C.muted}">mode: auto · read tools only</text>`);
  parts.push(`    <text x="378" y="246" font-size="13.5" fill="${C.muted}">read-only guard blocks every write</text>`);
  parts.push(`    <text x="378" y="357" font-size="16" font-weight="600" fill="${C.text}">Rating and judgment jobs</text>`);
  parts.push(`    <text x="378" y="380" font-size="13.5" fill="${C.muted}">mode: accept-edits · no tools at all</text>`);
  parts.push(`    <text x="378" y="400" font-size="13.5" fill="${C.muted}">see only the fenced evidence</text>`);
  parts.push(note(550, 478, "Mode full is never used.", { size: 13, fill: C.muted }));
  // Validators.
  parts.push(group(820, 90, 200, 240, "Strict validators"));
  ["schema and types", "known ids only", "https links only", "length caps"].forEach((s, i) => parts.push(box(838, 128 + i * 46, 164, 36, s, "box", 13.5)));
  parts.push(note(920, 318, "nothing unchecked is stored", { size: 12.5 }));
  // DB.
  parts.push(`    <rect x="1070" y="150" width="170" height="130" rx="16" fill="${C.node}" stroke="${C.accent}" stroke-width="2"/>`);
  parts.push(text(1155, 196, "Local plugin\ndatabase", { size: 17, weight: 700 }));
  parts.push(text(1155, 250, "SQLite, on this machine", { size: 13, fill: C.muted }));
  // Edges.
  parts.push(edge([[282, 218], [348, 218]], { label: "read", at: [315, 206] }));
  parts.push(edge([[732, 218], [818, 218]], { label: "model reply", at: [775, 206] }));
  parts.push(edge([[732, 372], [776, 372], [776, 300], [818, 300]]));
  parts.push(edge([[1022, 215], [1068, 215]], { accent: true }));
  parts.push(edge([[1155, 282], [1155, 410], [900, 410]], { dashed: true }));
  parts.push(note(1155, 432, "stored evidence re-enters\nonly inside a fresh fence", { size: 12.5 }));
  // Footer.
  parts.push(`    <rect x="40" y="500" width="1200" height="64" rx="16" fill="${C.node}" stroke="${C.accent}"/>`);
  parts.push(text(640, 523, "Nothing is sent anywhere except prompts to your own agent.", { size: 16, weight: 600 }));
  parts.push(text(640, 546, "No credentials in the plugin, no outbound calls of its own, no telemetry. Data stays in the local plugin database.", { size: 13.5, fill: C.muted }));
  return doc(W, H, "Paper Trail trust boundaries",
    "Third-party text from tickets, pull requests, meeting notes, chat, docs and code comments is untrusted. It only reaches the model inside an evidence fence whose marker is random for each prompt. Capture jobs run in auto mode with read tools and a read-only guard. Rating and judgment jobs run in accept-edits mode with no tools. Model replies pass strict validators (schema, known ids, https links, length caps) before they are stored in the local plugin database. Stored evidence re-enters only inside a fresh fence. Mode full is never used. Nothing is sent anywhere except prompts to your own agent.",
    parts.join("\n"));
}

// 6. Architecture (module map).

function architecture() {
  const W = 1280, H = 718;
  const parts = [heading(48, 40, "Module map")];
  // A: components.
  parts.push(group(40, 56, 1200, 102, "components · the tabs, in the bb UI"));
  ["Graph", "Time", "Week", "Threads", "Review", "Settings", "Onboarding flow"].forEach((s, i) => parts.push(box(58 + i * 169, 98, 157, 40, s, s === "Onboarding flow" ? "dashed" : "box", 14)));
  parts.push(note(1140, 148, "Radar in Threads · guardrails banner in Graph and Settings", { size: 12, anchor: "end" }));
  parts.push(edge([[620, 154], [620, 188]]), edge([[660, 188], [660, 154]]));
  parts.push(`    <text x="680" y="176" font-size="13" font-weight="600" fill="${C.muted}">typed RPC</text>`);
  // B: handlers + contract.
  parts.push(group(40, 190, 1200, 92, "lib/handlers · the RPC contract"));
  parts.push(box(58, 230, 372, 40, "lib/contract.ts · RpcContract, zod schemas", "decision", 14));
  parts.push(box(446, 230, 372, 40, "lib/handlers/* · one file per feature", "box", 14));
  parts.push(box(834, 230, 388, 40, "server.ts · registers handlers, runs the worker", "box", 14));
  // arrows B -> C
  [250, 640, 1020].forEach((x) => parts.push(edge([[x, 284], [x, 318]])));
  // C1: engine.
  parts.push(group(40, 320, 420, 290, "lib/engine"));
  [["service", "rating"], ["grid", "evidence"], ["extensions", "runner · queue"]].forEach((r, i) => {
    r.forEach((s, j) => parts.push(box(58 + j * 198, 362 + i * 56, 186, 44, s, j === 0 && i === 0 ? "decision" : "box", 14)));
  });
  parts.push(box(58, 530, 384, 38, "dates · time · schedule · markdown · json", "dashed", 13));
  // C2: capture.
  parts.push(group(480, 320, 250, 290, "lib/capture"));
  ["sources · context · identity", "jira · confluence", "github · slack", "meetings · common"].forEach((s, i) => parts.push(box(498, 362 + i * 52, 214, 42, s, "box", 13.5)));
  parts.push(note(605, 596, "prompts for the hidden threads", { size: 12.5 }));
  // C3: features.
  parts.push(group(750, 320, 490, 290, "lib/features/*"));
  const feats = ["drift", "guardrails", "overrides", "plan", "goals", "threads", "ghost", "packet", "setup", "migrate"];
  feats.forEach((s, i) => parts.push(box(768 + (i % 2) * 226, 362 + Math.floor(i / 2) * 44, 214, 36, s, "box", 14)));
  parts.push(note(995, 596, "each one: types, service, prompts, validators", { size: 12.5 }));
  // arrows C -> D.
  [250, 605, 995].forEach((x) => parts.push(edge([[x, 612], [x, 640]])));
  // D: storage.
  parts.push(`    <rect x="40" y="642" width="1200" height="56" rx="16" fill="${C.node}" stroke="${C.accent}" stroke-width="2"/>`);
  parts.push(`    <text x="64" y="675" font-size="17" font-weight="700" fill="${C.text}">lib/storage</text>`);
  parts.push(`    <text x="190" y="675" font-size="14" fill="${C.muted}">SQLite records · store.ts, db.ts, port.ts, memory.ts · the local plugin database</text>`);
  return doc(W, H, "Paper Trail module map",
    "The tabs in components call typed RPC handlers. lib/contract.ts defines the contract, lib/handlers has one file per feature, and server.ts registers them. Handlers use lib/engine (service, rating, grid, evidence, extensions, runner and queue, plus date, time, schedule, markdown and json helpers), lib/capture (prompts for the hidden threads: sources, context, identity, jira, confluence, github, slack, meetings) and lib/features (drift, guardrails, overrides, plan, goals, threads, ghost, packet, setup, migrate). All of it stores SQLite records through lib/storage.",
    parts.join("\n"));
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const files = {
  [join(ASSETS, "hero.svg")]: hero(),
  [join(OUT, "pipeline.svg")]: pipeline(),
  [join(OUT, "week-loop.svg")]: weekLoop(),
  [join(OUT, "setup.svg")]: setup(),
  [join(OUT, "security.svg")]: security(),
  [join(OUT, "architecture.svg")]: architecture(),
};
for (const [file, svg] of Object.entries(files)) {
  writeFileSync(file, svg);
  console.log("wrote", file.replace(ROOT + "/", ""), `${svg.length} bytes`);
}

// Optional: social-preview.png (1280x640) from the hero, if `sharp` can be found.
async function png() {
  let sharp;
  for (const from of [join(ROOT, "package.json"), process.env.SHARP_PATH]) {
    if (!from) continue;
    try {
      sharp = createRequire(from.endsWith("package.json") ? from : join(from, "x.js"))("sharp");
      break;
    } catch { /* try the next place */ }
  }
  if (!sharp) {
    console.log("skipped social-preview.png: no `sharp` in node_modules and $SHARP_PATH is unset");
    return;
  }
  const out = join(ASSETS, "social-preview.png");
  await sharp(Buffer.from(files[join(ASSETS, "hero.svg")].replaceAll("·", "|").replaceAll("…", "...")), { density: 144 }).resize(1280, 640).png({ compressionLevel: 9 }).toFile(out);
  console.log("wrote", out.replace(ROOT + "/", ""));
}
await png();
