// GitHub App auth helpers shared between server.ts (REST tasks) and
// review.ts (mints an installation token and forwards it to the gather
// subprocess so the GraphQL probe in scripts/gather_pr_triage_data.ts
// can verify greptile comment edit history).
import { createSign } from "node:crypto";

const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "";
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "";

export function appAuthAvailable(): boolean {
  return !!GITHUB_APP_ID && !!GITHUB_APP_PRIVATE_KEY;
}

export function makeAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: GITHUB_APP_ID }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256")
    .update(data)
    .sign(GITHUB_APP_PRIVATE_KEY, "base64url");
  return `${data}.${sig}`;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const r = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${makeAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok)
    throw new Error(`installation token failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

export async function getOrgInstallationId(org: string): Promise<number> {
  const r = await fetch(
    `https://api.github.com/orgs/${org}/installation`,
    {
      headers: {
        Authorization: `Bearer ${makeAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (r.ok) return ((await r.json()) as { id: number }).id;
  // Fall through to user-scope lookup so personal-account repos still resolve.
  const r2 = await fetch(
    `https://api.github.com/users/${org}/installation`,
    {
      headers: {
        Authorization: `Bearer ${makeAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r2.ok)
    throw new Error(
      `installation lookup failed for ${org}: ${r.status} / ${r2.status}`,
    );
  return ((await r2.json()) as { id: number }).id;
}

// Owner-scoped convenience: mint an installation token for the org/user
// that owns `owner`. Returns null on any failure (no app auth, owner not
// installed, network error) so callers can degrade gracefully.
export async function mintInstallationTokenForOwner(
  owner: string,
): Promise<string | null> {
  if (!appAuthAvailable()) return null;
  try {
    const id = await getOrgInstallationId(owner);
    return await getInstallationToken(id);
  } catch {
    return null;
  }
}
