import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GhGitHubReader,
  WatcherQueryError,
  resolveChecks,
  resolveContext,
  resolveReviewThreads,
  restReviewDecision,
  restRollupState,
} from "./github.ts";
import { readSnapshot } from "./policy.ts";
import { parsePrNumber } from "./types.ts";

const context = {
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(42),
};
const REFUSED =
  "HTTP 403: GitHub GraphQL is not available from Claude Code sessions; use the REST API (https://api.github.com/graphql)";

interface Route {
  readonly match: string;
  readonly stdout?: unknown;
  readonly stderr?: string;
  readonly code?: number;
}

let directory = "";
let originalPath = "";
let originalCwd = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "watch-pr-rest-"));
  originalPath = process.env.PATH ?? "";
  originalCwd = process.cwd();
  process.chdir(directory);
  writeFileSync(
    join(directory, "gh"),
    `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const key = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(join(directory, "calls"))}, key + "\\n");
for (const route of JSON.parse(readFileSync(${JSON.stringify(join(directory, "routes.json"))}, "utf8"))) {
  if (!new RegExp(route.match).test(key)) continue;
  if (route.stdout !== undefined) process.stdout.write(typeof route.stdout === "string" ? route.stdout : JSON.stringify(route.stdout));
  if (route.stderr !== undefined) process.stderr.write(route.stderr + "\\n");
  process.exit(route.code ?? 0);
}
process.stderr.write("unexpected gh " + key + "\\n");
process.exit(2);
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${directory}:${originalPath}`;
});
afterEach(() => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  rmSync(directory, { recursive: true, force: true });
});
function routes(items: readonly Route[]): void {
  writeFileSync(join(directory, "routes.json"), JSON.stringify(items));
}
function calls(): string[] {
  try {
    return readFileSync(join(directory, "calls"), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const refusedCli: readonly Route[] = [
  { match: "^pr ", stderr: REFUSED, code: 1 },
  { match: "^api graphql", stderr: REFUSED, code: 1 },
];
const pull = {
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open",
  draft: false,
  merged_at: null,
  mergeable: true,
  mergeable_state: "blocked",
  head: { sha: "head-sha", ref: "feature" },
  base: { ref: "main" },
};
const restSnapshot: readonly Route[] = [
  ...refusedCli,
  {
    match: "^api --method GET repos/owner/repo/pulls/42/reviews ",
    stdout: [
      {
        user: { login: "alice" },
        state: "CHANGES_REQUESTED",
      },
      { user: { login: "alice" }, state: "COMMENTED" },
      { user: { login: "bob" }, state: "APPROVED" },
    ],
  },
  {
    match: "^api --method GET repos/owner/repo/pulls/42/ccr/review_threads$",
    stdout: [
      {
        resolved: false,
        outdated: false,
        path: "src/a.ts",
        line: 3,
        comment_ids: [12, 11],
      },
      {
        resolved: true,
        outdated: true,
        path: "src/b.ts",
        line: null,
        comment_ids: [20],
      },
    ],
  },
  {
    match: "^api --method GET repos/owner/repo/pulls/42/comments ",
    stdout: [
      {
        id: 11,
        body: "first\nmore",
        created_at: "2026-11-19T00:00:00Z",
        path: "src/a.ts",
        line: 3,
        user: { login: "cursor[bot]" },
      },
      {
        id: 12,
        body: "reply",
        created_at: "2026-11-19T00:01:00Z",
        path: "src/a.ts",
        line: 3,
        user: null,
      },
      {
        id: 20,
        body: "old",
        created_at: "2026-11-18T00:00:00Z",
        path: "src/b.ts",
        user: { login: "carol" },
      },
    ],
  },
  {
    match: "^api --method GET repos/owner/repo/pulls/42$",
    stdout: pull,
  },
  {
    match: "^api --method GET repos/owner/repo/commits/head-sha/check-runs ",
    stdout: {
      total_count: 2,
      check_runs: [
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          details_url: "https://ci.example/lint",
        },
        {
          name: "test",
          status: "completed",
          conclusion: "failure",
          details_url: "https://ci.example/test",
        },
      ],
    },
  },
  {
    match: "^api --method GET repos/owner/repo/commits/head-sha/status ",
    stdout: {
      state: "pending",
      statuses: [
        {
          context: "deploy",
          state: "pending",
          target_url: "https://ci.example/deploy",
          description: "waiting",
        },
      ],
    },
  },
];

describe("REST fallback after GitHub refuses GraphQL", () => {
  it("reads a whole snapshot through REST and stops calling GraphQL", async () => {
    routes(restSnapshot);
    const reader = new GhGitHubReader();
    const snapshot = await readSnapshot({
      reader,
      context,
      pendingHistory: "include",
      allowDraft: false,
    });
    expect(snapshot.kind).toBe("open");
    if (snapshot.kind !== "open") return;
    expect(snapshot.facts).toEqual({
      context,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "CHANGES_REQUESTED",
      headRefOid: "head-sha",
      headRefName: "feature",
      baseRefName: "main",
      state: "OPEN",
      mergedAt: null,
      isDraft: false,
    });
    expect(snapshot.threads).toEqual([
      {
        id: "11",
        firstComment: {
          authorLogin: "cursor[bot]",
          body: "first\nmore",
          path: "src/a.ts",
          line: 3,
          createdAt: "2026-11-19T00:00:00Z",
        },
        isBugbot: false,
        bugbotReviewPasses: 0,
      },
    ]);
    expect(snapshot.ci.kind).toBe("ci-failing");
    expect(
      snapshot.ci.all.map((check) => [check.name, check.kind, check.link])
    ).toEqual([
      ["lint", "passed", "https://ci.example/lint"],
      ["test", "failed", "https://ci.example/test"],
      ["deploy", "pending", "https://ci.example/deploy"],
    ]);
    if (snapshot.ci.kind === "ci-failing")
      expect(snapshot.ci.github).toEqual({
        kind: "refused",
        mergeStateStatus: "BLOCKED",
        headRollupState: "FAILURE",
      });
    const made = calls();
    expect(made.filter((call) => /^(pr |api graphql)/.test(call))).toEqual([
      "pr view 42 --repo owner/repo --json mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft",
    ]);
    expect(made.every((call) => !call.includes("{owner}"))).toBe(true);
  });

  for (const detail of [
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)",
  ])
    it(`keeps the gh failure and skips REST after: ${detail}`, async () => {
      routes([
        { match: "^pr view", stderr: detail, code: 1 },
        { match: "^api ", stdout: pull },
      ]);
      const error = await new GhGitHubReader()
        .pullRequest(context)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WatcherQueryError);
      expect((error as WatcherQueryError).failure).toMatchObject({
        kind: "command-exit",
        detail,
      });
      expect(calls().filter((call) => call.startsWith("api "))).toEqual([]);
    });

  it("reports an empty REST check list as unavailable checks", async () => {
    routes([
      ...refusedCli,
      {
        match: "^api --method GET repos/owner/repo/pulls/42$",
        stdout: pull,
      },
      {
        match: "/check-runs ",
        stdout: { total_count: 0, check_runs: [] },
      },
      { match: "/status ", stdout: { state: "pending", statuses: [] } },
    ]);
    const reader = new GhGitHubReader();
    await expect(resolveChecks(reader, context)).rejects.toMatchObject({
      failure: { kind: "checks-unavailable" },
    });
    expect(await reader.commitRollups(context)).toEqual([
      { oid: "head-sha", state: null },
    ]);
  });

  it("pages open pull requests and marks fork heads as cross-repository", async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        number: start + index,
        head: {
          ref: `branch-${start + index}`,
          repo: { full_name: "owner/repo" },
        },
        base: { ref: "main", repo: { full_name: "owner/repo" } },
      }));
    routes([
      ...refusedCli,
      {
        match: "pulls\\?state=open -F per_page=100 -F page=1$",
        stdout: page(1, 100),
      },
      {
        match: "pulls\\?state=open -F per_page=100 -F page=2$",
        stdout: [
          ...page(101, 1),
          {
            number: 102,
            head: { ref: "fork", repo: { full_name: "someone/repo" } },
            base: { ref: "main", repo: { full_name: "owner/repo" } },
          },
          {
            number: 103,
            head: { ref: "gone", repo: null },
            base: { ref: "main", repo: { full_name: "owner/repo" } },
          },
        ],
      },
    ]);
    const open = await new GhGitHubReader().openPullRequests(context);
    expect(open).toHaveLength(103);
    expect(open.slice(99)).toEqual([
      {
        number: parsePrNumber(100),
        headRefName: "branch-100",
        baseRefName: "main",
        isCrossRepository: false,
      },
      {
        number: parsePrNumber(101),
        headRefName: "branch-101",
        baseRefName: "main",
        isCrossRepository: false,
      },
      {
        number: parsePrNumber(102),
        headRefName: "fork",
        baseRefName: "main",
        isCrossRepository: true,
      },
      {
        number: parsePrNumber(103),
        headRefName: "gone",
        baseRefName: "main",
        isCrossRepository: true,
      },
    ]);
  });

  it("infers the current branch's open PR through gh's repository placeholders", async () => {
    const placeholders =
      "^api --method GET repos/\\{owner\\}/\\{repo\\}/pulls -F head=\\{owner\\}:\\{branch\\}";
    routes([
      ...refusedCli,
      {
        match: `${placeholders} -f state=open`,
        stdout: [
          {
            number: 9,
            state: "open",
            html_url: "https://github.com/owner/repo/pull/9",
          },
        ],
      },
    ]);
    const reader = new GhGitHubReader();
    expect(
      await resolveContext({ reader, owner: null, repo: null, pr: null })
    ).toEqual({ owner: "owner", repo: "repo", number: parsePrNumber(9) });
    routes([
      ...refusedCli,
      { match: `${placeholders} -f state=open`, stdout: [] },
      {
        match: `${placeholders} -f state=all`,
        stdout: [
          {
            number: 7,
            state: "closed",
            html_url: "https://github.com/owner/repo/pull/7",
          },
        ],
      },
    ]);
    expect(await reader.currentPr(null)).toEqual({
      owner: "owner",
      repo: "repo",
      number: parsePrNumber(7),
    });
  });

  it("finds a fork branch's PR under its push remote's owner", async () => {
    const checkout = join(directory, "checkout");
    mkdirSync(checkout);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("checkout", "-q", "-b", "feature");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "initial"
    );
    git("remote", "add", "origin", "https://github.com/owner/repo.git");
    git("remote", "add", "fork", "git@github.com:someone/repo.git");
    git("config", "branch.feature.pushRemote", "fork");
    process.chdir(checkout);
    routes([
      ...refusedCli,
      {
        match:
          "^api --method GET repos/\\{owner\\}/\\{repo\\}/pulls -f head=someone:feature -f state=open",
        stdout: [
          {
            number: 11,
            state: "open",
            html_url: "https://github.com/owner/repo/pull/11",
          },
        ],
      },
    ]);
    expect(await new GhGitHubReader().currentPr(null)).toEqual({
      owner: "owner",
      repo: "repo",
      number: parsePrNumber(11),
    });
  });

  it("fails closed when a REST thread has no comments", async () => {
    routes([
      ...refusedCli,
      {
        match: "ccr/review_threads$",
        stdout: [{ resolved: false, comment_ids: [] }],
      },
      { match: "/comments ", stdout: [] },
    ]);
    await expect(
      resolveReviewThreads(new GhGitHubReader(), context)
    ).rejects.toMatchObject({ failure: { kind: "missing-key" } });
  });
});

describe("REST mappings", () => {
  it("rolls check runs and statuses up like the GraphQL rollup", () => {
    const run = (status: string, conclusion: string | null = null) => ({
      __typename: "CheckRun",
      status,
      conclusion,
    });
    const status = (state: string) => ({ __typename: "StatusContext", state });
    expect(restRollupState([])).toBeNull();
    expect(
      restRollupState([
        run("completed", "success"),
        run("completed", "neutral"),
        run("completed", "skipped"),
        status("success"),
      ])
    ).toBe("SUCCESS");
    expect(
      restRollupState([run("completed", "success"), run("in_progress")])
    ).toBe("PENDING");
    expect(restRollupState([run("queued"), status("error")])).toBe("ERROR");
    expect(
      restRollupState([status("error"), run("completed", "action_required")])
    ).toBe("FAILURE");
    expect(restRollupState([run("completed", "cancelled")])).toBe("FAILURE");
  });

  it("derives a review decision from each reviewer's latest decisive review", () => {
    expect(restReviewDecision([])).toBeNull();
    expect(
      restReviewDecision([
        { user: { login: "a" }, state: "COMMENTED" },
        { user: null, state: "CHANGES_REQUESTED" },
      ])
    ).toBeNull();
    expect(
      restReviewDecision([
        { user: { login: "a" }, state: "CHANGES_REQUESTED" },
        { user: { login: "a" }, state: "APPROVED" },
      ])
    ).toBe("APPROVED");
    expect(
      restReviewDecision([
        { user: { login: "a" }, state: "DISMISSED" },
        { user: { login: "b" }, state: "APPROVED" },
      ])
    ).toBe("APPROVED");
    expect(
      restReviewDecision([
        { user: { login: "a" }, state: "CHANGES_REQUESTED" },
        { user: { login: "a" }, state: "DISMISSED" },
        { user: { login: "b" }, state: "APPROVED" },
      ])
    ).toBe("CHANGES_REQUESTED");
    expect(
      restReviewDecision([
        { user: { login: "a" }, state: "APPROVED" },
        { user: { login: "b" }, state: "CHANGES_REQUESTED" },
      ])
    ).toBe("CHANGES_REQUESTED");
  });
});
