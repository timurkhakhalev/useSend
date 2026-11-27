import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    teamUser: {
      findFirst: vi.fn(),
    },
    teamInvite: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("~/server/db", () => ({
  db: mockDb,
}));

vi.mock("~/server/auth", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
}));

vi.mock("~/server/service/webhook-service", () => ({}));

import { createCallerFactory } from "~/server/api/trpc";
import { teamRouter } from "~/server/api/routers/team";

const createCaller = createCallerFactory(teamRouter);

function getContext(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);

  return {
    db: mockDb,
    headers,
    session: {
      user: {
        id: 7,
        email: "owner@example.com",
        isWaitlisted: false,
        isAdmin: false,
        isBetaUser: true,
      },
    },
  } as any;
}

function membership(teamId: number) {
  return {
    teamId,
    userId: 7,
    role: "ADMIN",
    team: { id: teamId, name: `Team ${teamId}` },
  };
}

describe("teamProcedure active team", () => {
  beforeEach(() => {
    mockDb.teamUser.findFirst.mockReset();
    mockDb.teamInvite.findMany.mockReset();
    mockDb.teamInvite.findMany.mockResolvedValue([]);
  });

  it("uses the team from the cookie when the user is a member", async () => {
    mockDb.teamUser.findFirst.mockResolvedValueOnce(membership(2));

    await createCaller(
      getContext("theme=dark; usesend-team-id=2"),
    ).getTeamInvites();

    expect(mockDb.teamUser.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.teamUser.findFirst).toHaveBeenCalledWith({
      where: { userId: 7, teamId: 2 },
      include: { team: true },
    });
    expect(mockDb.teamInvite.findMany).toHaveBeenCalledWith({
      where: { teamId: 2 },
    });
  });

  it("falls back to the lowest team id when the cookie team is not the user's", async () => {
    mockDb.teamUser.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(membership(1));

    await createCaller(getContext("usesend-team-id=99")).getTeamInvites();

    expect(mockDb.teamUser.findFirst).toHaveBeenLastCalledWith({
      where: { userId: 7 },
      include: { team: true },
      orderBy: { teamId: "asc" },
    });
    expect(mockDb.teamInvite.findMany).toHaveBeenCalledWith({
      where: { teamId: 1 },
    });
  });

  it("ignores a malformed cookie", async () => {
    mockDb.teamUser.findFirst.mockResolvedValueOnce(membership(1));

    await createCaller(getContext("usesend-team-id=2abc")).getTeamInvites();

    expect(mockDb.teamUser.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.teamUser.findFirst).toHaveBeenCalledWith({
      where: { userId: 7 },
      include: { team: true },
      orderBy: { teamId: "asc" },
    });
  });
});
