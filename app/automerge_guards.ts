// Guards used by the auto-merge hook. Kept in a separate module so smoke
// tests can import them without triggering server.ts's top-level startup
// side effects (DB init, port bind, hook registration).

export type FirstTimeAuthorResult = {
  is_first_time: boolean;
  prior_merges: number | null; // null = couldn't determine (API err → fail closed)
  api_error: boolean;
};

// Returns whether `login` has zero merged PRs in `repo`, plus enough context
// for the caller to log *why* we said so. Fail-CLOSED: a non-2xx response
// from the GitHub search API still reports `is_first_time: true` so the PR
// is quarantined when we can't verify history, but `api_error: true` lets
// the caller distinguish "verified zero merges" from "we couldn't ask".
// Network errors throw and bubble up to the auto-merge caller's try/catch.
export async function isFirstTimeAuthor(
  token: string,
  repo: string,
  login: string,
): Promise<FirstTimeAuthorResult> {
  const q = `repo:${repo} is:pr is:merged author:${login}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) {
    return { is_first_time: true, prior_merges: null, api_error: true };
  }
  const data = (await r.json()) as { total_count: number };
  return {
    is_first_time: data.total_count === 0,
    prior_merges: data.total_count,
    api_error: false,
  };
}
