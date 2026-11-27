import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockEnv, mockRedis } = vi.hoisted(() => ({
  mockDb: {
    team: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
  mockEnv: { NEXT_PUBLIC_IS_CLOUD: false },
  mockRedis: { setex: vi.fn() },
}));

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/env", () => ({ env: mockEnv }));
vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
}));

import { TeamService } from "~/server/service/team-service";

describe("TeamService.createTeam on a self-hosted instance", () => {
  beforeEach(() => {
    mockEnv.NEXT_PUBLIC_IS_CLOUD = false;
    mockDb.team.findMany.mockReset();
    mockDb.team.findFirst.mockReset();
    mockDb.team.findUnique.mockReset();
    mockDb.team.create.mockReset();
    mockDb.team.create.mockResolvedValue({ id: 2, name: "Marketing" });
    mockDb.team.findUnique.mockResolvedValue({ id: 2, name: "Marketing" });
  });

  it("lets a member of a team create another team", async () => {
    mockDb.team.findMany.mockResolvedValue([{ id: 1, name: "Main" }]);

    const team = await TeamService.createTeam(7, "Marketing");

    expect(team).toEqual({ id: 2, name: "Marketing" });
    expect(mockDb.team.create).toHaveBeenCalledWith({
      data: {
        name: "Marketing",
        teamUsers: { create: { userId: 7, role: "ADMIN" } },
      },
    });
  });

  it("refuses a user without a team when the instance already has a team", async () => {
    mockDb.team.findMany.mockResolvedValue([]);
    mockDb.team.findFirst.mockResolvedValue({ id: 1, name: "Main" });

    await expect(TeamService.createTeam(8, "Other")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mockDb.team.create).not.toHaveBeenCalled();
  });

  it("creates the first team of the instance", async () => {
    mockDb.team.findMany.mockResolvedValue([]);
    mockDb.team.findFirst.mockResolvedValue(null);

    await TeamService.createTeam(7, "Main");

    expect(mockDb.team.create).toHaveBeenCalled();
  });
});
