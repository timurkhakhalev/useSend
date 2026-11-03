import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSns, mockSes, mockIsPostbox, mockFetch } = vi.hoisted(
  () => ({
    mockDb: {
      sesSetting: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
    mockSns: {
      createTopic: vi.fn(),
      subscribeEndpoint: vi.fn(),
      deleteTopic: vi.fn(),
    },
    mockSes: {
      addWebhookConfiguration: vi.fn(),
    },
    mockIsPostbox: vi.fn(),
    mockFetch: vi.fn(),
  }),
);

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/aws/sns", () => mockSns);
vi.mock("~/server/aws/ses", () => mockSes);
vi.mock("~/server/aws/postbox", () => ({
  isPostbox: mockIsPostbox,
  getPostboxStreamArn: (region: string) => `arn:yc:yds:${region}::stream`,
}));
vi.mock("./email-queue-service", () => ({
  EmailQueueService: { initializeQueue: vi.fn() },
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { SesSettingsService } from "~/server/service/ses-settings-service";

describe("SesSettingsService.createSesSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue({ status: 200, statusText: "OK" });
    mockDb.sesSetting.findMany.mockResolvedValue([]);
    mockDb.sesSetting.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: "setting-1", ...data }),
    );
    mockDb.sesSetting.update.mockResolvedValue({});
    mockSes.addWebhookConfiguration.mockResolvedValue(true);
    mockSns.createTopic.mockResolvedValue("arn:aws:sns:topic");
  });

  it("uses the YDS stream instead of SNS in Postbox mode", async () => {
    mockIsPostbox.mockReturnValue(true);

    await SesSettingsService.createSesSetting({
      region: "ru-central1",
      usesendUrl: "https://usesend.example.com/",
      sendingRateLimit: 1,
      transactionalQuota: 50,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSns.createTopic).not.toHaveBeenCalled();
    expect(mockSns.subscribeEndpoint).not.toHaveBeenCalled();
    expect(mockDb.sesSetting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        region: "ru-central1",
        topic: "arn:yc:yds:ru-central1::stream",
        topicArn: undefined,
      }),
    });
    expect(mockSes.addWebhookConfiguration).toHaveBeenCalledTimes(4);
    for (const call of mockSes.addWebhookConfiguration.mock.calls) {
      expect(call[1]).toEqual({
        type: "yds",
        streamArn: "arn:yc:yds:ru-central1::stream",
      });
    }
  });

  it("keeps the SNS flow in SES mode", async () => {
    mockIsPostbox.mockReturnValue(false);
    mockDb.sesSetting.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: "setting-2", ...data }),
    );

    await SesSettingsService.createSesSetting({
      region: "us-east-1",
      usesendUrl: "https://usesend.example.com",
      sendingRateLimit: 1,
      transactionalQuota: 50,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://usesend.example.com/api/ses_callback",
      { method: "GET" },
    );
    expect(mockSns.subscribeEndpoint).toHaveBeenCalledWith(
      "arn:aws:sns:topic",
      "https://usesend.example.com/api/ses_callback",
      "us-east-1",
    );
    expect(mockSes.addWebhookConfiguration.mock.calls[0]?.[1]).toEqual({
      type: "sns",
      topicArn: "arn:aws:sns:topic",
    });
  });
});
