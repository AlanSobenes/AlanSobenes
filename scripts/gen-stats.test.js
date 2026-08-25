const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(__dirname, 'gen-stats.js');

function fixedDate(now) {
  const RealDate = Date;
  return class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
  };
}

function loadGenerator(fetchImpl, now = '2025-01-10T12:00:00.000Z') {
  const source = fs.readFileSync(GENERATOR, 'utf8');
  const mainMarker = '/* ------------------------------------------------------------------ main */';
  const markerIndex = source.indexOf(mainMarker);
  assert.notEqual(markerIndex, -1, 'generator main marker should exist');

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    __dirname,
    console,
    fetch: fetchImpl,
    Date: fixedDate(now),
    process: {
      env: { GITHUB_TOKEN: 'test-token', STATS_USER: 'fixture-user' },
      exit(code) { throw new Error(`unexpected process.exit(${code})`); },
    },
  };
  const testableSource = `${source.slice(0, markerIndex)}\nmodule.exports = { collect, render, DARK };`;
  vm.runInNewContext(testableSource, sandbox, { filename: GENERATOR });
  return sandbox.module.exports;
}

function githubFixture({ createdAt, repos = 17, daysByYear = {} }) {
  let repositoryQuery = '';
  const fetchImpl = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (query.includes('repositories(')) {
      repositoryQuery = query;
      return {
        ok: true,
        json: async () => ({
          data: {
            user: {
              createdAt,
              followers: { totalCount: 4 },
              repositories: { totalCount: repos },
            },
          },
        }),
      };
    }

    const year = new Date(variables.f).getUTCFullYear();
    const contributionDays = daysByYear[year] || [];
    return {
      ok: true,
      json: async () => ({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                totalContributions: contributionDays.reduce(
                  (sum, day) => sum + day.contributionCount,
                  0
                ),
                weeks: [{ contributionDays }],
              },
            },
          },
        },
      }),
    };
  };

  return { fetchImpl, repositoryQuery: () => repositoryQuery };
}

test('refresh workflow runs when generator changes land on main', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'refresh-stats.yml'),
    'utf8'
  );

  assert.match(workflow, /branches:\s*\[main\]/);
  assert.doesNotMatch(workflow, /branches:\s*\[master\]/);
});

test('active days use the same trailing-12-month window as contributions', async () => {
  const api = githubFixture({
    createdAt: '2024-01-01T00:00:00.000Z',
    daysByYear: {
      2024: [
        { date: '2024-01-01', contributionCount: 11 },
        { date: '2024-12-01', contributionCount: 3 },
      ],
      2025: [{ date: '2025-01-09', contributionCount: 2 }],
    },
  });
  const { collect } = loadGenerator(api.fetchImpl);

  const stats = await collect();

  assert.equal(stats.lastYear, 5);
  assert.equal(stats.activeDays, 2);
});

test('repository tile counts and labels every public repository', async () => {
  const api = githubFixture({
    createdAt: '2025-01-01T00:00:00.000Z',
    repos: 17,
    daysByYear: {
      2025: [{ date: '2025-01-09', contributionCount: 1 }],
    },
  });
  const { collect, render, DARK } = loadGenerator(api.fetchImpl);

  const stats = await collect();
  const svg = render(stats, DARK);
  const query = api.repositoryQuery().replace(/\s+/g, '');

  assert.match(query, /repositories\(ownerAffiliations:OWNER,privacy:PUBLIC\)/);
  assert.doesNotMatch(query, /isFork:/);
  assert.match(svg, />PUBLIC REPOS<\/text>/);
  assert.match(svg, /17 public repositories/);
});
