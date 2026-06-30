import fs from "fs";
import path from "path";

const username = process.env.GITHUB_ACTOR;
const token = process.env.ACCESS_TOKEN;

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

async function fetchUserCreationDate() {
  const data = await gql(`query($u:String!){user(login:$u){createdAt}}`, { u: username });
  return new Date(data.user.createdAt);
}

async function fetchContributionsForPeriod(from, to) {
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
    { u: username, from: from.toISOString(), to: to.toISOString() }
  );
  return data.user.contributionsCollection;
}

async function fetchLatestCommit() {
  try {
    // Search commits API returns the most recent commit by this user across all repos
    const response = await fetch(
      `${REST_API}/search/commits?q=author:${username}&sort=committer-date&order=desc&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const item = data.items?.[0];
    if (!item) return null;
    return {
      repo: item.repository.full_name,
      message: item.commit.message.split("\n")[0],
      date: item.commit.committer.date,
    };
  } catch {
    return null;
  }
}

async function fetchOwnedRepos() {
  const data = await gql(
    `query($u:String!){user(login:$u){repositories(first:100,ownerAffiliations:OWNER){nodes{nameWithOwner}}}}`,
    { u: username }
  );
  return data.user.repositories.nodes
    .map((r) => r.nameWithOwner)
    .filter((r) => !isExcluded(r));
}

async function fetchLinesForRepo(repo) {
  try {
    const contributors = await rest(`/repos/${repo}/stats/contributors`);
    if (!Array.isArray(contributors)) return { additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const entry of contributors) {
      if (entry?.author?.login !== username) continue;
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

async function main() {
  try {
    const createdAt = await fetchUserCreationDate();
    const now = new Date();

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
      const col = await fetchContributionsForPeriod(cursor, end);
      totalCommits += col.contributionCalendar.totalContributions;
      for (const { repository } of col.commitContributionsByRepository) {
        if (!isExcluded(repository.nameWithOwner)) {
          reposTouchedSet.add(repository.nameWithOwner);
        }
      }
      cursor = end;
    }

    // Use owned repos only for line counts (matches what the SVG cards show)
    const ownedRepos = await fetchOwnedRepos();
    const lineResults = await Promise.all(ownedRepos.map(fetchLinesForRepo));
    const totalAdditions = lineResults.reduce((s, r) => s + r.additions, 0);
    const totalDeletions = lineResults.reduce((s, r) => s + r.deletions, 0);

    const latestCommit = await fetchLatestCommit();

    const stats = {
      commits: totalCommits,
      reposTouched: reposTouchedSet.size,
      linesChanged: totalAdditions + totalDeletions,
      additions: totalAdditions,
      deletions: totalDeletions,
      netLines: totalAdditions - totalDeletions,
      latestCommit,
      updatedAt: now.toISOString(),
    };

    const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "output");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, "stats.json");
    fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
    console.log(`JSON file created: ${outPath}`);
  } catch (error) {
    console.error("Error generating stats JSON:", error);
    process.exit(1);
  }
}

main();
