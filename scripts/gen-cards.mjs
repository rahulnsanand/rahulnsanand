#!/usr/bin/env node
// Builds the profile cards: one SVG per panel, in a dark and a light variant.
// Zero dependencies. Text lives in profile.json; numbers come from the public
// GitHub and npm APIs at build time. Run: node scripts/gen-cards.mjs [outDir]
//
// Every card paints a translucent surface instead of a solid background, so it
// sits correctly on GitHub's light, dark, dark-dimmed and high-contrast themes.
// Fonts (OFL) and the logo are embedded as data URIs: an SVG loaded through
// <img> cannot fetch anything else.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "cards"));
const profile = JSON.parse(readFileSync(join(ROOT, "profile.json"), "utf8"));
const icons = JSON.parse(readFileSync(join(ROOT, "scripts/icons.json"), "utf8"));

// ---------------------------------------------------------------- theme ----

// Palette from rahulnsanand.com (src/styles/foundation/tokens-theme.css).
const THEMES = {
  dark: {
    text: "#ECECF0", muted: "#94949B", faint: "#6B6B73", line: "#4A4A52",
    surface: "rgba(255,255,255,0.025)", chip: "rgba(255,255,255,0.04)",
    brand: "#2A79C3", brandText: "#5AA2E6", dot: "rgba(255,255,255,0.07)",
  },
  light: {
    text: "#2B2B2B", muted: "#66666C", faint: "#8E8E95", line: "#D2D2D6",
    surface: "rgba(0,0,0,0.018)", chip: "rgba(0,0,0,0.03)",
    brand: "#2A79C3", brandText: "#1F67AB", dot: "rgba(0,0,0,0.07)",
  },
};

const FONTS = {
  heading: ["Montserrat", 700, "montserrat-latin-700-normal.woff2"],
  text: ["Lato", 400, "lato-latin-400-normal.woff2"],
  textBold: ["Lato", 700, "lato-latin-700-normal.woff2"],
  mono: ["JetBrains Mono", 500, "jetbrains-mono-latin-500-normal.woff2"],
};
const FAMILY = {
  heading: "'Montserrat','Segoe UI',system-ui,sans-serif",
  text: "'Lato','Segoe UI',system-ui,sans-serif",
  mono: "'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,monospace",
};

const b64 = (file) => readFileSync(file).toString("base64");
const fontCache = {};
function fontFace(key) {
  const [family, weight, file] = FONTS[key];
  fontCache[key] ??= b64(join(ROOT, "fonts", file));
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${fontCache[key]}) format('woff2');}`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Rough advance widths (in em) per font, good enough to size chips and wrap text.
const EM = { heading: 0.66, text: 0.47, textBold: 0.5, mono: 0.6 };
const textWidth = (s, size, font = "text") => [...String(s)].length * size * EM[font];

function wrap(text, maxWidth, size, font = "text") {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size, font) > maxWidth) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const clip = (s, maxChars) => (s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s);

function svg({ w, h, title, fonts, t, body, extraCss = "" }) {
  const css = [
    ...fonts.map(fontFace),
    `.h{font-family:${FAMILY.heading};font-weight:700}`,
    `.t{font-family:${FAMILY.text};font-weight:400}`,
    `.tb{font-family:${FAMILY.text};font-weight:700}`,
    `.m{font-family:${FAMILY.mono};font-weight:500}`,
    `.fg{fill:${t.text}}.mu{fill:${t.muted}}.fa{fill:${t.faint}}.br{fill:${t.brandText}}`,
    `.fade{animation:fade .7s ease-out both}`,
    `@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`,
    extraCss,
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`,
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}" fill="none">
<title>${esc(title)}</title>
<style>${css}</style>
${body}
</svg>
`;
}

// A rounded panel. `x`/`w` let half-width cards leave a transparent gap.
const panel = (t, x, y, w, h, r = 14) =>
  `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="${t.surface}" stroke="${t.line}"/>`;

const label = (t, x, y, text) => `<text x="${x}" y="${y}" class="m br" font-size="13" letter-spacing="0.4">// ${esc(text)}</text>`;

function chip(t, x, y, text, { size = 13, font = "text", h = 26, color } = {}) {
  const w = Math.round(textWidth(text, size, font) + 24);
  const cls = font === "mono" ? "m" : "t";
  return {
    w,
    svg: `<g><rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${h / 2}" fill="${t.chip}" stroke="${t.line}"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" text-anchor="middle" class="${cls}" font-size="${size}" fill="${color ?? t.text}">${esc(text)}</text></g>`,
  };
}

// Floors, never rounds up: 11,674 is "11.6k", not "12k".
const compact = (n) => (n >= 1000 ? `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k` : String(n));

// ----------------------------------------------------------------- data ----

const GH = "https://api.github.com";
const ghHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "rahulnsanand-profile-cards",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function get(url, headers = ghHeaders) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const NPM_UA = { "user-agent": "rahulnsanand-profile-cards" };
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// All-time npm downloads for one package. The API serves at most 18 months per
// request, so walk forward from the first publish in 500-day windows. Any
// failure throws: a short count must never be published as the real one.
async function npmAllTime(name) {
  const meta = await get(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, NPM_UA);
  const end = Date.now() - DAY;
  let total = 0;
  for (let from = Date.parse(meta.time.created.slice(0, 10)); from <= end; from += 500 * DAY) {
    const to = Math.min(from + 499 * DAY, end);
    const r = await get(`https://api.npmjs.org/downloads/range/${ymd(from)}:${ymd(to)}/${name}`, NPM_UA);
    total += r.downloads.reduce((n, d) => n + d.downloads, 0);
  }
  return total;
}

// Docker Hub pulls for every public image in a namespace.
async function dockerPulls(namespace) {
  const images = {};
  let url = `https://hub.docker.com/v2/repositories/${namespace}/?page_size=100`;
  while (url) {
    const page = await get(url, NPM_UA);
    for (const r of page.results) images[r.name] = r.pull_count;
    url = page.next;
  }
  return { total: Object.values(images).reduce((a, b) => a + b, 0), images };
}

async function loadData() {
  const { login, downloads, activity } = profile;
  const user = await get(`${GH}/users/${login}`);

  const repoLists = await Promise.all(
    activity.orgs.map((o) => get(o === login ? `${GH}/users/${o}/repos?per_page=100&type=owner` : `${GH}/orgs/${o}/repos?per_page=100&type=public`)),
  );
  const repos = repoLists.flat().filter((r) => !r.fork && !r.private && !r.archived);
  const stars = repos.reduce((s, r) => s + r.stargazers_count, 0);

  // Language share by bytes over every public, non-fork repo.
  const langs = {};
  const langLists = await Promise.all(repos.map((r) => get(r.languages_url).catch(() => ({}))));
  for (const l of langLists) for (const [k, v] of Object.entries(l)) langs[k] = (langs[k] ?? 0) + v;

  const npm = {};
  for (const name of downloads.npm) npm[name] = await npmAllTime(name);
  const docker = await dockerPulls(downloads.dockerHub);

  // Latest releases: the newest stable release of each public repo, one row
  // per repo, newest first. A monorepo tags each package (luthor@2.11.15,
  // headless@2.11.15): those fold into one row.
  const releases = [];
  for (const r of repos) {
    const rels = (await get(`${GH}/repos/${r.full_name}/releases?per_page=20`)).filter((x) => !x.draft && !x.prerelease);
    if (!rels.length) continue;
    rels.sort((x, y) => y.published_at.localeCompare(x.published_at));
    const split = (tag) => (tag.includes("@") ? tag.split("@") : [null, tag]);
    const [, version] = split(rels[0].tag_name);
    const same = rels.filter((x) => split(x.tag_name)[1] === version);
    releases.push({
      repo: r.full_name,
      name: r.name,
      date: rels[0].published_at,
      version: /^\d/.test(version) ? `v${version}` : version,
      pkgs: same.map((x) => split(x.tag_name)[0]).filter(Boolean),
    });
  }
  releases.sort((x, y) => y.date.localeCompare(x.date));

  return {
    user: { repos: user.public_repos, followers: user.followers, since: new Date(user.created_at).getUTCFullYear() },
    stars, langs, npm, docker, releases: releases.slice(0, activity.limit),
  };
}

// ---------------------------------------------------------------- cards ----

const W = 1000;

function header(t) {
  const h = 290;
  // The glass logo: one still frame of the old animated GIF (a 3D "ra" on a
  // dark disc, transparent around it), so it reads on light and dark alike.
  const logo = 190, lx = 46, ly = (h - logo) / 2;
  const tx = lx + logo + 42;
  const words = profile.words.map((word, i) =>
    `<text x="${W - 28}" y="${h + 22}" text-anchor="end" class="h word w${i}" font-size="138" fill="${t.text}">${esc(word)}</text>`).join("");
  let cx = tx;
  const chips = profile.chips.map((c, i) => { const ch = chip(t, cx, 218, c, { size: 13 }); cx += ch.w + 10; return `<g class="fade" style="animation-delay:${0.5 + i * 0.12}s">${ch.svg}</g>`; }).join("");
  const headW = textWidth(profile.headline, 20, "mono");
  const n = profile.words.length, cycle = n * 3;
  const extraCss =
    `.word{opacity:0;animation:word ${cycle}s ease-in-out infinite}.w0{opacity:.045}` +
    profile.words.map((_, i) => `.w${i}{animation-delay:${i * 3 - 0.01}s}`).join("") +
    `@keyframes word{0%{opacity:0}${(100 / n) * 0.15}%{opacity:.045}${(100 / n) * 0.85}%{opacity:.045}${100 / n}%{opacity:0}100%{opacity:0}}` +
    `.caret{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}` +
    `.float{animation:float 6s ease-in-out infinite}@keyframes float{50%{transform:translateY(-5px)}}` +
    `.glow{transform-box:fill-box;transform-origin:center;animation:glow 6s ease-in-out infinite}@keyframes glow{50%{opacity:.55;transform:scale(1.05)}}`;
  const body = `
<defs><radialGradient id="glow"><stop offset="55%" stop-color="${t.brand}" stop-opacity=".28"/><stop offset="100%" stop-color="${t.brand}" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${t.dot}"/></pattern>
<clipPath id="clip"><rect x="1" y="1" width="${W - 2}" height="${h - 2}" rx="14"/></clipPath></defs>
${panel(t, 0, 0, W, h)}
<g clip-path="url(#clip)"><rect width="${W}" height="${h}" fill="url(#dots)"/>${words}
<rect x="0" y="0" width="5" height="${h}" fill="${t.brand}"/></g>
<g class="fade"><circle class="glow" cx="${lx + logo / 2}" cy="${ly + logo / 2}" r="${logo * 0.62}" fill="url(#glow)"/>
<g class="float"><image x="${lx}" y="${ly}" width="${logo}" height="${logo}" href="data:image/png;base64,${b64(join(ROOT, "assets", "logo-glass.png"))}"/></g></g>
<text x="${tx}" y="70" class="m br fade" font-size="14">${esc(profile.kicker)}</text>
<text x="${tx}" y="124" class="h fg fade" font-size="46" style="animation-delay:.1s">${esc(profile.name)}</text>
<g class="fade" style="animation-delay:.2s"><text x="${tx}" y="162" class="m mu" font-size="20">${esc(profile.headline)}</text>
<rect class="caret" x="${tx + headW + 4}" y="146" width="10" height="20" fill="${t.brand}"/></g>
<text x="${tx}" y="198" class="t fg fade" font-size="18" style="animation-delay:.3s">${esc(profile.tagline)}</text>
${chips}
<text x="${tx}" y="${h - 22}" class="m br fade" font-size="14" style="animation-delay:.8s">}</text>`;
  return svg({ w: W, h, title: `${profile.name}, ${profile.headline}. ${profile.tagline}`, fonts: ["heading", "text", "mono"], t, body, extraCss });
}

function linkTile(t, link) {
  const s = 44;
  let glyph;
  if (link.id === "web") {
    glyph = `<g transform="translate(12 12)" stroke="${t.text}" stroke-width="1.6" fill="none"><circle cx="10" cy="10" r="9"/><ellipse cx="10" cy="10" rx="4" ry="9"/><path d="M1 10h18M2.6 5h14.8M2.6 15h14.8"/></g>`;
  } else if (link.id === "linkedin") {
    glyph = `<g transform="translate(12 12)" fill="${t.text}"><rect x="1" y="7" width="4" height="12" rx=".6"/><circle cx="3" cy="3" r="2.3"/><path d="M8 7h3.8v1.8c.6-1.1 2-2.1 4-2.1 3.3 0 4.2 2.1 4.2 5V19h-4v-6.4c0-1.6-.4-2.7-1.9-2.7-1.6 0-2.2 1.2-2.2 2.8V19H8z"/></g>`;
  } else if (link.id === "medium") {
    glyph = `<g transform="translate(10 15)" fill="${t.text}"><ellipse cx="6.2" cy="7" rx="6.2" ry="6.6"/><ellipse cx="16.1" cy="7" rx="3.1" ry="6.2"/><ellipse cx="22.2" cy="7" rx="1.2" ry="5.6"/></g>`;
  } else {
    glyph = `<path transform="translate(12 12) scale(0.8333)" d="${icons[link.id]}" fill="${t.text}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" role="img" aria-label="${esc(link.label)}">
<title>${esc(link.label)}</title>
<rect x="0.5" y="0.5" width="${s - 1}" height="${s - 1}" rx="11" fill="${t.surface}" stroke="${t.line}"/>
${glyph}
</svg>
`;
}

function now(t) {
  const colW = (W - 3 * 40) / 2;
  const cols = profile.now.map((c, i) => {
    const x = 40 + i * (colW + 40);
    let y = 112;
    const bullets = c.bullets.map((b) => {
      const lines = wrap(b, colW - 22, 15);
      const out = `<circle cx="${x + 4}" cy="${y - 5}" r="2.6" fill="${t.brand}"/>` +
        lines.map((l, k) => `<text x="${x + 18}" y="${y + k * 21}" class="t fg" font-size="15">${esc(l)}</text>`).join("");
      y += lines.length * 21 + 10;
      return out;
    }).join("");
    return { y, svg: `<g class="fade" style="animation-delay:${i * 0.15}s">${label(t, x, 42, c.label)}
<text x="${x}" y="74" class="h fg" font-size="20">${esc(c.title)}</text>
<line x1="${x}" y1="88" x2="${x + colW}" y2="88" stroke="${t.line}" stroke-dasharray="3 4"/>
${bullets}</g>` };
  });
  const h = Math.max(...cols.map((c) => c.y)) + 12;
  const body = `${panel(t, 0, 0, W, h)}<line x1="${W / 2}" y1="28" x2="${W / 2}" y2="${h - 28}" stroke="${t.line}"/>${cols.map((c) => c.svg).join("")}`;
  const title = profile.now.map((c) => `${c.title}: ${c.bullets.join("; ")}`).join(". ");
  return svg({ w: W, h, title, fonts: ["heading", "text", "mono"], t, body });
}

const HALF_H = 250;
// Half-width cards: 500 wide, the panel inset 8px on the inner edge so the pair
// shows a 16px gap while the outer edges line up with full-width cards.
const half = (side) => (side === "left" ? { x: 0, w: 492 } : { x: 8, w: 492 });

function stack(t) {
  const rowH = 46, top = 64;
  const h = top + (profile.stack.length - 1) * rowH + 40;
  const rows = profile.stack.map((g, i) => {
    const y = top + i * rowH;
    let cx = 190;
    const chips = g.items.map((it) => { const c = chip(t, cx, y - 18, it, { size: 14, h: 30 }); cx += c.w + 10; return c.svg; }).join("");
    return `<g class="fade" style="animation-delay:${i * 0.1}s"><text x="40" y="${y + 2}" class="m mu" font-size="13">${esc(g.label)}</text>${chips}</g>`;
  }).join("");
  const body = `${panel(t, 0, 0, W, h)}${label(t, 40, 38, "stack")}${rows}`;
  return svg({ w: W, h, title: profile.stack.map((g) => `${g.label}: ${g.items.join(", ")}`).join(". "), fonts: ["text", "mono"], t, body });
}

function releasesCard(t, items) {
  const rowH = 40, top = 72;
  const h = top + (Math.max(items.length, 1) - 1) * rowH + 36;
  const blurbs = profile.activity.blurbs ?? {};
  const rows = items.map((it, i) => {
    const y = top + i * rowH;
    const ver = chip(t, 0, 0, it.version, { size: 12, font: "mono", h: 24 });
    const verX = W - 40 - ver.w;
    const verSvg = chip(t, verX, y - 17, it.version, { size: 12, font: "mono", h: 24, color: t.brandText }).svg;
    const display = blurbs[it.repo]?.name ?? `${it.name[0].toUpperCase()}${it.name.slice(1)}`;
    const nameX = 156, blurbX = nameX + textWidth(display, 16, "textBold") + 12;
    const extra = [blurbs[it.repo]?.blurb, it.pkgs.length > 1 ? it.pkgs.join(" + ") : null].filter(Boolean).join("  ·  ");
    const repoRight = verX - 16;
    const room = repoRight - textWidth(it.repo, 13, "mono") - 24 - blurbX;
    return `<g class="fade" style="animation-delay:${i * 0.08}s">
<text x="40" y="${y}" class="m mu" font-size="13">${it.date.slice(0, 10)}</text>
<text x="${nameX}" y="${y}"><tspan class="tb fg" font-size="16">${esc(display)}</tspan><tspan dx="10" class="t mu" font-size="15">${esc(clip(extra, Math.floor(room / (15 * EM.text))))}</tspan></text>
<text x="${repoRight}" y="${y}" text-anchor="end" class="m br" font-size="13">${esc(it.repo)}</text>${verSvg}
${i < items.length - 1 ? `<line x1="40" y1="${y + 19}" x2="${W - 40}" y2="${y + 19}" stroke="${t.line}" opacity=".5"/>` : ""}</g>`;
  }).join("");
  const body = `${panel(t, 0, 0, W, h)}${label(t, 40, 38, "latest releases")}${rows || `<text x="40" y="${top}" class="t mu" font-size="15">No releases yet.</text>`}`;
  const title = `Latest releases: ${items.map((i) => `${i.repo} ${i.version} (${i.date.slice(0, 10)})`).join("; ")}`;
  return svg({ w: W, h, title, fonts: ["text", "textBold", "mono"], t, body });
}

// GitHub linguist colours for the languages likely to show up.
const LANG_COLORS = { "C#": "#178600", TypeScript: "#3178c6", JavaScript: "#f1e05a", Java: "#b07219", Kotlin: "#A97BFF", Astro: "#ff5a03", CSS: "#663399", HTML: "#e34c26", Scala: "#c22d40", Shell: "#89e051", Dockerfile: "#384d54", PowerShell: "#012456", Python: "#3572A5", MDX: "#fcb32c" };

function languages(t, langs) {
  const { x, w } = half("left");
  const ix = x + 28, barW = w - 56;
  const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5).reduce((s, [, v]) => s + v, 0);
  if (rest) top.push(["Other", rest]);
  let bx = ix;
  const segs = top.map(([k, v], i) => {
    const sw = Math.max(2, (v / total) * barW);
    const r = `<rect x="${bx}" y="62" width="${sw}" height="10" fill="${LANG_COLORS[k] ?? t.faint}" class="grow" style="animation-delay:${i * 0.08}s"/>`;
    bx += sw;
    return r;
  }).join("");
  const list = top.map(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = ix + col * (barW / 2), ly = 112 + row * 34;
    return `<g class="fade" style="animation-delay:${0.2 + i * 0.06}s"><circle cx="${lx + 5}" cy="${ly - 5}" r="5" fill="${LANG_COLORS[k] ?? t.faint}"/>
<text x="${lx + 18}" y="${ly}" class="t fg" font-size="15">${esc(k)}</text>
<text x="${lx + barW / 2 - 20}" y="${ly}" text-anchor="end" class="m mu" font-size="13">${((v / total) * 100).toFixed(1)}%</text></g>`;
  }).join("");
  const body = `${panel(t, x, 0, w, HALF_H)}${label(t, ix, 38, "languages")}
<clipPath id="bar"><rect x="${ix}" y="62" width="${barW}" height="10" rx="5"/></clipPath><g clip-path="url(#bar)">${segs}</g>${list}
<text x="${ix}" y="${HALF_H - 22}" class="m fa" font-size="11">by bytes, public non-fork repos</text>`;
  const extraCss = `.grow{transform-box:fill-box;transform-origin:left;animation:grow .9s cubic-bezier(.2,.7,.2,1) both}@keyframes grow{from{transform:scaleX(0)}to{transform:none}}`;
  return svg({ w: 500, h: HALF_H, title: `Languages by bytes: ${top.map(([k, v]) => `${k} ${((v / total) * 100).toFixed(1)}%`).join(", ")}`, fonts: ["text", "mono"], t, body, extraCss });
}

// Floor to whole thousands with a "+", so the headline never overstates.
const floorK = (n) => (n >= 1000 ? `${Math.floor(n / 1000)}k+` : String(n));

function numbers(t, data) {
  const { x, w } = half("right");
  const ix = x + 28, colW = (w - 56) / 3;
  const npmTotal = Object.values(data.npm).reduce((a, b) => a + b, 0);
  const total = npmTotal + data.docker.total;
  const cells = [
    [compact(npmTotal), "npm downloads"],
    [compact(data.docker.total), "Docker pulls"],
    [compact(data.stars), "GitHub stars"],
  ];
  const body = `${panel(t, x, 0, w, HALF_H)}${label(t, ix, 38, "numbers")}
<g class="fade"><text x="${ix}" y="104" class="h fg" font-size="54">${floorK(total)}</text>
<text x="${ix}" y="132" class="t mu" font-size="15">downloads of my open-source work, all time</text></g>
<line x1="${ix}" y1="156" x2="${x + w - 28}" y2="156" stroke="${t.line}" stroke-dasharray="3 4"/>` + cells.map(([n, l], i) => {
    const cx = ix + i * colW;
    return `<g class="fade" style="animation-delay:${0.15 + i * 0.08}s"><text x="${cx}" y="198" class="h fg" font-size="28">${esc(n)}</text>
<text x="${cx}" y="222" class="t mu" font-size="14">${esc(l)}</text></g>`;
  }).join("");
  const title = `${floorK(total)} all-time downloads: ${cells.map(([n, l]) => `${n} ${l}`).join(", ")}.`;
  return svg({ w: 500, h: HALF_H, title, fonts: ["heading", "text", "mono"], t, body });
}

// ----------------------------------------------------------------- main ----

const data = await loadData();
mkdirSync(OUT, { recursive: true });
const written = [];
for (const [name, t] of Object.entries(THEMES)) {
  const files = {
    header: header(t),
    now: now(t),
    stack: stack(t),
    releases: releasesCard(t, data.releases),
    languages: languages(t, data.langs),
    numbers: numbers(t, data),
    ...Object.fromEntries(profile.links.map((l) => [`link-${l.id}`, linkTile(t, l)])),
  };
  for (const [base, content] of Object.entries(files)) {
    const f = join(OUT, `${base}-${name}.svg`);
    writeFileSync(f, content);
    written.push(f);
  }
}
// No timestamp: an unchanged day must produce byte-identical output, so the
// workflow skips the commit.
writeFileSync(join(OUT, "data.json"), JSON.stringify(data, null, 2) + "\n");
console.log(`wrote ${written.length} cards to ${OUT}`);
