/**
 * Cookie that holds the id of the team the dashboard works with.
 * A user can belong to several teams; without the cookie (or with a team the
 * user is not a member of) the team with the lowest id is used.
 */
export const ACTIVE_TEAM_COOKIE = "usesend-team-id";

/** Reads the active team id from a `Cookie` header value. */
export function parseActiveTeamId(cookieHeader: string | null | undefined) {
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (rawName?.trim() !== ACTIVE_TEAM_COOKIE) continue;

    const value = rest.join("=").trim();
    if (!/^\d+$/.test(value)) return undefined;

    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }

  return undefined;
}
