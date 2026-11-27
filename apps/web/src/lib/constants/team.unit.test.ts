import { describe, expect, it } from "vitest";
import { parseActiveTeamId } from "~/lib/constants/team";

describe("parseActiveTeamId", () => {
  it("reads the team id among other cookies", () => {
    expect(parseActiveTeamId("a=1; usesend-team-id=12; b=2")).toBe(12);
  });

  it("returns undefined without the cookie", () => {
    expect(parseActiveTeamId(undefined)).toBeUndefined();
    expect(parseActiveTeamId("a=1")).toBeUndefined();
  });

  it("rejects values that are not positive integers", () => {
    expect(parseActiveTeamId("usesend-team-id=0")).toBeUndefined();
    expect(parseActiveTeamId("usesend-team-id=-1")).toBeUndefined();
    expect(parseActiveTeamId("usesend-team-id=1.5")).toBeUndefined();
    expect(parseActiveTeamId("usesend-team-id=")).toBeUndefined();
  });
});
