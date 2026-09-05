import fs from "fs";
import path from "path";

const username = process.env.GITHUB_ACTOR;
const token = process.env.ACCESS_TOKEN;
const adasjuskUsername = "adasjusk";

const excludedRepos = process.env.EXCLUDED_REPOS
  ? process.env.EXCLUDED_REPOS.split(",").map((r) => r.trim().toLowerCase())
  : [];

if (!token) {
  console.error("Error: ACCESS_TOKEN is not defined in environment variables.");
  process.exit(1);
}

const GRAPHQL_API = "https://api.github.com/graphql";
const REST_API = "https://api.github.com";

async function gql(query, variables = {}) {
  const response = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error("GitHub GraphQL request failed");
  const data = await response.json();
  if (data.errors) throw new Error("GitHub GraphQL errors: " + JSON.stringify(data.errors));
  return data.data;
}

async function rest(endpoint, maxRetries = 8) {
  let response;
  let attempts = 0;
  do {
    response = await fetch(`${REST_API}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (response.status === 202) {
      if (++attempts >= maxRetries) throw new Error(`REST ${endpoint} timed out (202 after ${maxRetries} retries)`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else if (!response.ok) {
      throw new Error(`REST ${endpoint} failed: ${response.status}`);
    }
  } while (response.status === 202);
  return response.json();
}

function isExcluded(nameWithOwner) {
  const lower = nameWithOwner.toLowerCase();
  const short = lower.split("/")[1];
  return excludedRepos.includes(lower) || excludedRepos.includes(short);
}

async function fetchUserCreationDate(targetUsername) {
  const data = await gql(`query($u:String!){user(login:$u){createdAt}}`, { u: targetUsername });
  return new Date(data.user.createdAt);
}

async function fetchContributionsForPeriod(targetUsername, from, to) {
  const data = await gql(
    `query($u:String!,$from:DateTime!,$to:DateTime!){
      user(login:$u){
        contributionsCollection(from:$from,to:$to){
          contributionCalendar{totalContributions}
          commitContributionsByRepository(maxRepositories:100){
            repository{nameWithOwner}
          }
        }
      }
    }`,
    { u: targetUsername, from: from.toISOString(), to: to.toISOString() }
  );
  return data.user.contributionsCollection;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The Search API is sensitive to secondary rate limits (especially right after a
// burst of concurrent REST calls) and can answer 403/429 with a Retry-After. It
// also returns 202 while GitHub builds the index. Retry those instead of silently
// giving up, which is why latestCommit used to always come back null.
async function githubGet(endpoint, accept, maxRetries = 6) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(`${REST_API}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "User-Agent": "stats-generator",
      },
    });
    if (response.ok) return response.json();
    if (response.status === 202 || response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
      await sleep(wait);
      continue;
    }
    throw new Error(`GitHub GET ${endpoint} failed: ${response.status}`);
  }
  throw new Error(`GitHub GET ${endpoint} exhausted retries`);
}

async function fetchLatestCommitViaSearch(targetUsername) {
  // Search commits API returns the most recent commit by this user across all repos
  const data = await githubGet(
    `/search/commits?q=author:${targetUsername}&sort=committer-date&order=desc&per_page=1`,
    "application/vnd.github+json"
  );
  const item = data.items?.[0];
  if (!item) return null;
  return {
    repo: item.repository.full_name,
    message: item.commit.message.split("\n")[0],
    date: item.commit.committer.date,
  };
}

async function fetchLatestCommitViaRepos(targetUsername) {
  // Fallback that avoids the Search API entirely: walk the most recently pushed
  // repos and grab the newest commit actually authored by this user.
  const repos = await githubGet(
    `/users/${targetUsername}/repos?sort=pushed&per_page=10`,
    "application/vnd.github+json"
  );
  if (!Array.isArray(repos)) return null;
  for (const repo of repos) {
    if (isExcluded(repo.full_name)) continue;
    try {
      const commits = await githubGet(
        `/repos/${repo.full_name}/commits?author=${targetUsername}&per_page=1`,
        "application/vnd.github+json"
      );
      const commit = Array.isArray(commits) ? commits[0] : null;
      if (!commit) continue;
      return {
        repo: repo.full_name,
        message: commit.commit.message.split("\n")[0],
        date: commit.commit.committer.date,
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchLatestCommit(targetUsername) {
  try {
    const viaSearch = await fetchLatestCommitViaSearch(targetUsername);
    if (viaSearch) return viaSearch;
  } catch (error) {
    console.warn(`Latest commit via search failed for ${targetUsername}: ${error.message}`);
  }
  try {
    return await fetchLatestCommitViaRepos(targetUsername);
  } catch (error) {
    console.warn(`Latest commit via repos failed for ${targetUsername}: ${error.message}`);
    return null;
  }
}

async function fetchOwnedRepos(targetUsername) {
  const data = await gql(
    `query($u:String!){user(login:$u){repositories(first:100,ownerAffiliations:OWNER){nodes{nameWithOwner}}}}`,
    { u: targetUsername }
  );
  return data.user.repositories.nodes
    .map((r) => r.nameWithOwner)
    .filter((r) => !isExcluded(r));
}

async function fetchLinesForRepo(targetUsername, repo) {
  try {
    const contributors = await rest(`/repos/${repo}/stats/contributors`);
    if (!Array.isArray(contributors)) return { additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const entry of contributors) {
      if (entry?.author?.login !== targetUsername) continue;
      for (const week of entry.weeks || []) {
        additions += week.a || 0;
        deletions += week.d || 0;
      }
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

async function buildStats(targetUsername, now) {
  const createdAt = await fetchUserCreationDate(targetUsername);

  let totalCommits = 0;
  const reposTouchedSet = new Set();

  let cursor = new Date(createdAt);
  while (cursor < now) {
    const end = new Date(
      Math.min(
        new Date(cursor.getFullYear() + 1, cursor.getMonth(), cursor.getDate()).getTime(),
        now.getTime()
      )
    );
    const col = await fetchContributionsForPeriod(targetUsername, cursor, end);
    totalCommits += col.contributionCalendar.totalContributions;
    for (const { repository } of col.commitContributionsByRepository) {
      if (!isExcluded(repository.nameWithOwner)) {
        reposTouchedSet.add(repository.nameWithOwner);
      }
    }
    cursor = end;
  }

  // Fetch the latest commit before the concurrent line-count burst below, so the
  // rate-limit-sensitive Search API isn't hit right after ~100 parallel requests.
  const latestCommit = await fetchLatestCommit(targetUsername);

  // Use owned repos only for line counts (matches what the SVG cards show)
  const ownedRepos = await fetchOwnedRepos(targetUsername);
  const lineResults = await Promise.all(ownedRepos.map((repo) => fetchLinesForRepo(targetUsername, repo)));
  const totalAdditions = lineResults.reduce((s, r) => s + r.additions, 0);
  const totalDeletions = lineResults.reduce((s, r) => s + r.deletions, 0);

  return {
    commits: totalCommits,
    reposTouched: reposTouchedSet.size,
    linesChanged: totalAdditions + totalDeletions,
    additions: totalAdditions,
    deletions: totalDeletions,
    netLines: totalAdditions - totalDeletions,
    latestCommit,
    updatedAt: now.toISOString(),
  };
}

async function main() {
  try {
    const now = new Date();
    const stats = await buildStats(username, now);
    const adasjuskStats = await buildStats(adasjuskUsername, now);

    const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "output");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, "stats.json");
    const adasjuskOutPath = path.join(outDir, "stats-adasjusk.json");
    fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
    fs.writeFileSync(adasjuskOutPath, JSON.stringify(adasjuskStats, null, 2));
    console.log(`JSON file created: ${outPath}`);
    console.log(`JSON file created: ${adasjuskOutPath}`);
  } catch (error) {
    console.error("Error generating stats JSON:", error);
    process.exit(1);
  }
}

main();
