// Guards used by the auto-merge hook. Kept in a separate module so smoke
// tests can import them without triggering server.ts's top-level startup
// side effects (DB init, port bind, hook registration).

// Returns true if `login` has zero merged PRs in `repo`. Fail-CLOSED: a
// non-2xx response from the GitHub search API also returns true so the PR is
// quarantined when we can't verify the author's history. Network errors
// throw and bubble up to the auto-merge caller's try/catch.
export async function isFirstTimeAuthor(
  token: string,
  repo: string,
  login: string,
): Promise<boolean> {
  const q = `repo:${repo} is:pr is:merged author:${login}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) return true;
  const data = (await r.json()) as { total_count: number };
  return data.total_count === 0;
}
