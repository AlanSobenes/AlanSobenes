#!/usr/bin/env node
/**
 * Builds assets/stats-{dark,light}.svg from real GitHub contribution data.
 *
 * Self-hosted on purpose: third-party README stat services rate-limit, 503, or
 * die outright (the Heroku streak service is gone). This runs in Actions on a
 * daily cron and commits the rendered SVG, so the profile never shows a broken
 * image.
 *
 * Auth: needs GITHUB_TOKEN (Actions provides it) or GH_TOKEN locally.
 */
const fs = require('fs');
const path = require('path');

const USER = process.env.STATS_USER || 'AlanSobenes';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const OUT = path.resolve(__dirname, '..', 'assets');

if (!TOKEN) {
  console.error('Missing GITHUB_TOKEN / GH_TOKEN');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USER}-profile-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/* ---------------------------------------------------------------- fetch */
async function collect() {
  const base = await gql(
    `query($u:String!){
      user(login:$u){
        createdAt
        followers{totalCount}
        repositories(ownerAffiliations:OWNER, isFork:false){totalCount}
      }
    }`,
    { u: USER }
  );
  const u = base.user;
  const start = new Date(u.createdAt);
  const now = new Date();

  // contributionCalendar caps at one year per query, so walk year windows.
  const days = [];
  for (let y = start.getFullYear(); y <= now.getFullYear(); y++) {
    const from = new Date(Math.max(start.getTime(), Date.UTC(y, 0, 1)));
    const to = new Date(Math.min(now.getTime(), Date.UTC(y, 11, 31, 23, 59, 59)));
    if (from > to) continue;
    const d = await gql(
      `query($u:String!,$f:DateTime!,$t:DateTime!){
        user(login:$u){ contributionsCollection(from:$f,to:$t){
          contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
        }}
      }`,
      { u: USER, f: from.toISOString(), t: to.toISOString() }
    );
    for (const w of d.user.contributionsCollection.contributionCalendar.weeks) {
      for (const cd of w.contributionDays) days.push(cd);
    }
  }

  // de-dupe on date, sort ascending
  const byDate = new Map();
  for (const d of days) byDate.set(d.date, d.contributionCount);
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const total = sorted.reduce((a, [, c]) => a + c, 0);
  const activeDays = sorted.filter(([, c]) => c > 0).length;
  const best = sorted.reduce((m, d) => (d[1] > m[1] ? d : m), ['', 0]);

  // streaks — today counts as "not yet broken" if it is still 0
  const todayISO = now.toISOString().slice(0, 10);
  let longest = 0, run = 0, current = 0;
  for (const [, c] of sorted) {
    if (c > 0) { run++; longest = Math.max(longest, run); }
    else run = 0;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const [date, c] = sorted[i];
    if (c > 0) current++;
    else if (date === todayISO) continue; // today is still in progress
    else break;
  }

  // last 12 months
  const yearAgo = new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const lastYear = sorted.filter(([d]) => d >= yearAgo).reduce((a, [, c]) => a + c, 0);

  const years = ((now - start) / (365.25 * 864e5)).toFixed(1);

  return {
    total, lastYear, current, longest, activeDays, best,
    repos: u.repositories.totalCount,
    followers: u.followers.totalCount,
    years,
    since: u.createdAt.slice(0, 10),
    spark: sorted.slice(-182), // ~6 months for the sparkline
    generated: now.toISOString().slice(0, 10),
  };
}

/* --------------------------------------------------------------- render */
const MONO = "ui-monospace,SFMono-Regular,'Cascadia Mono',Menlo,Consolas,monospace";
const SANS = "'Segoe UI',Inter,-apple-system,'Helvetica Neue',Arial,sans-serif";

const DARK = {
  key: 'dark', bg: '#0a0e17', card: '#111827', line: '#1f2a3d',
  head: '#f1f5f9', dim: '#64748b', text: '#cbd5e1',
  cyan: '#22d3ee', violet: '#a78bfa', green: '#4ade80', pink: '#f472b6', amber: '#fbbf24',
  sparkLo: '#1e293b',
};
const LIGHT = {
  key: 'light', bg: '#ffffff', card: '#f8fafc', line: '#e2e8f0',
  head: '#0f172a', dim: '#94a3b8', text: '#334155',
  cyan: '#0891b2', violet: '#7c3aed', green: '#16a34a', pink: '#db2777', amber: '#d97706',
  sparkLo: '#e2e8f0',
};

const nf = (n) => n.toLocaleString('en-US');

function render(s, P) {
  const W = 1100, H = 268;
  const padX = 34;

  const tiles = [
    { v: nf(s.total), l: 'TOTAL CONTRIBUTIONS', s: `since ${s.since}`, k: 'cyan' },
    { v: nf(s.lastYear), l: 'PAST 12 MONTHS', s: `${s.activeDays} active days`, k: 'violet' },
    { v: nf(s.current), l: 'CURRENT STREAK', s: `longest ${nf(s.longest)} days`, k: 'green' },
    { v: nf(s.repos), l: 'REPOSITORIES', s: `${s.years} yrs shipping`, k: 'amber' },
  ];

  const tw = 244, gx = 15, ty = 92, th = 96;
  let cards = '';
  tiles.forEach((t, i) => {
    const x = padX + i * (tw + gx);
    const a = P[t.k];
    cards += `<g class="rise" style="animation-delay:${(0.12 + i * 0.1).toFixed(2)}s">
      <rect x="${x}" y="${ty}" width="${tw}" height="${th}" rx="11" fill="${P.card}" stroke="${P.line}"/>
      <rect x="${x}" y="${ty}" width="${tw}" height="3" rx="1.5" fill="${a}"/>
      <text x="${x + 18}" y="${ty + 47}" font-family="${SANS}" font-size="31" font-weight="800" letter-spacing="-0.6" fill="${P.head}">${t.v}</text>
      <text x="${x + 18}" y="${ty + 68}" font-family="${MONO}" font-size="10.5" font-weight="700" letter-spacing="1.4" fill="${a}">${t.l}</text>
      <text x="${x + 18}" y="${ty + 84}" font-family="${MONO}" font-size="10.5" fill="${P.dim}">${t.s}</text></g>`;
  });

  // sparkline of the last ~6 months
  const sx = padX, sy = 212, sw = W - padX * 2, sh = 30;
  const max = Math.max(1, ...s.spark.map(([, c]) => c));
  const bw = sw / s.spark.length;
  let bars = '';
  s.spark.forEach(([date, c], i) => {
    const h = c === 0 ? 1.5 : Math.max(2.5, (c / max) * sh);
    const fill = c === 0 ? P.sparkLo : c > max * 0.6 ? P.cyan : c > max * 0.25 ? P.violet : P.green;
    bars += `<rect x="${(sx + i * bw).toFixed(2)}" y="${(sy + sh - h).toFixed(2)}" width="${Math.max(1.1, bw - 0.9).toFixed(2)}" height="${h.toFixed(2)}" rx="0.8" fill="${fill}" opacity="${c === 0 ? 0.55 : 0.9}"><animate attributeName="height" from="0" to="${h.toFixed(2)}" dur="0.5s" begin="${(i * 0.003).toFixed(3)}s" fill="freeze"/><animate attributeName="y" from="${sy + sh}" to="${(sy + sh - h).toFixed(2)}" dur="0.5s" begin="${(i * 0.003).toFixed(3)}s" fill="freeze"/></rect>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="GitHub activity: ${nf(s.total)} total contributions since ${s.since}, ${nf(s.lastYear)} in the past 12 months, current streak ${s.current} days, longest ${s.longest} days, ${s.repos} repositories">
<defs><style>@media (prefers-reduced-motion: no-preference){.rise{animation:rise .6s cubic-bezier(.2,.8,.3,1)}}@keyframes rise{from{opacity:.55;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}</style></defs>
<rect width="${W}" height="${H}" rx="14" fill="${P.bg}" stroke="${P.line}"/>
<text x="${padX}" y="46" font-family="${SANS}" font-size="20" font-weight="700" fill="${P.head}">Activity</text>
<text x="${padX + 88}" y="46" font-family="${MONO}" font-size="12.5" fill="${P.dim}">self-hosted, refreshed daily &#183; ${s.generated}</text>
<line x1="${padX}" y1="64" x2="${W - padX}" y2="64" stroke="${P.line}"/>
${cards}
<text x="${padX}" y="203" font-family="${MONO}" font-size="10.5" font-weight="700" letter-spacing="1.4" fill="${P.dim}">LAST 6 MONTHS</text>
${bars}
<line x1="${sx}" y1="${sy + sh + 4}" x2="${sx + sw}" y2="${sy + sh + 4}" stroke="${P.line}"/>
</svg>`;
}

/* ------------------------------------------------------------------ main */
(async () => {
  const s = await collect();
  fs.mkdirSync(OUT, { recursive: true });
  for (const P of [DARK, LIGHT]) {
    fs.writeFileSync(path.join(OUT, `stats-${P.key}.svg`), render(s, P));
  }
  console.log(
    `stats: total=${s.total} last12mo=${s.lastYear} current=${s.current} longest=${s.longest} ` +
    `repos=${s.repos} active=${s.activeDays} best=${s.best[0]}(${s.best[1]}) years=${s.years}`
  );
})().catch((e) => { console.error(e); process.exit(1); });
