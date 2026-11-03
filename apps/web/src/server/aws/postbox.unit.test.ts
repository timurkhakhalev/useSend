import {
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    EMAIL_PROVIDER: "postbox" as "ses" | "postbox",
    POSTBOX_YDS_ENDPOINT: "https://yds.serverless.yandexcloud.net/",
    POSTBOX_YDS_STREAM: "/ru-central1/cloud-1/db-1/postbox-events" as
      string | undefined,
    AWS_SES_ENDPOINT: undefined as string | undefined,
    AWS_ACCESS_KEY_ID: "key",
    AWS_SECRET_ACCESS_KEY: "secret",
  },
}));

vi.mock("~/env", () => ({ env: mockEnv }));

import {
  filterSupportedEventTypes,
  getPostboxStreamArn,
} from "~/server/aws/postbox";
import { addDomain, addWebhookConfiguration } from "~/server/aws/ses";

describe("postbox", () => {
  let sendSpy: ReturnType<typeof mockSesSend>;

  function mockSesSend() {
    return vi
      .spyOn(SESv2Client.prototype, "send")
      .mockResolvedValue({ $metadata: { httpStatusCode: 200 } } as never);
  }

  function sentCommands() {
    return sendSpy.mock.calls.map((call) => call[0] as unknown);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mockEnv.EMAIL_PROVIDER = "postbox";
    mockEnv.POSTBOX_YDS_STREAM = "/ru-central1/cloud-1/db-1/postbox-events";
    sendSpy = mockSesSend();
  });

  describe("getPostboxStreamArn", () => {
    it("builds the YDS stream ARN Postbox expects", () => {
      expect(getPostboxStreamArn("ru-central1")).toBe(
        "arn:yc:yds:ru-central1::https://yds.serverless.yandexcloud.net/ru-central1/cloud-1/db-1:postbox-events",
      );
    });

    it("accepts a stream path without the leading slash", () => {
      mockEnv.POSTBOX_YDS_STREAM = "ru-central1/cloud-1/db-1/postbox-events";
      expect(getPostboxStreamArn("ru-central1")).toContain(
        "yandexcloud.net/ru-central1/cloud-1/db-1:postbox-events",
      );
    });

    it("rejects a missing or partial stream path", () => {
      mockEnv.POSTBOX_YDS_STREAM = undefined;
      expect(() => getPostboxStreamArn("ru-central1")).toThrow(
        /POSTBOX_YDS_STREAM is required/,
      );

      mockEnv.POSTBOX_YDS_STREAM = "postbox-events";
      expect(() => getPostboxStreamArn("ru-central1")).toThrow(
        /full stream path/,
      );
    });
  });

  it("drops event types Postbox does not support", () => {
    expect(filterSupportedEventTypes(["SEND", "REJECT", "OPEN"])).toEqual([
      "SEND",
      "OPEN",
    ]);

    mockEnv.EMAIL_PROVIDER = "ses";
    expect(filterSupportedEventTypes(["SEND", "REJECT"])).toEqual([
      "SEND",
      "REJECT",
    ]);
  });

  it("sends events to the YDS stream through a Kinesis destination", async () => {
    await addWebhookConfiguration(
      "config-general",
      { type: "yds", streamArn: "arn:yc:yds:stream" },
      ["SEND", "REJECT", "DELIVERY"],
      "ru-central1",
    );

    const command = sentCommands().find(
      (cmd) => cmd instanceof CreateConfigurationSetEventDestinationCommand,
    ) as CreateConfigurationSetEventDestinationCommand;

    expect(command.input.EventDestination).toEqual({
      Enabled: true,
      MatchingEventTypes: ["SEND", "DELIVERY"],
      KinesisFirehoseDestination: expect.objectContaining({
        DeliveryStreamArn: "arn:yc:yds:stream",
      }),
    });
  });

  it("creates a BYODKIM identity without a MAIL FROM domain", async () => {
    const { publicKey } = await addDomain("mail.example.com", "ru-central1");

    const commands = sentCommands();
    expect(publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(CreateEmailIdentityCommand);
    expect(
      commands.some(
        (cmd) => cmd instanceof PutEmailIdentityMailFromAttributesCommand,
      ),
    ).toBe(false);
  });

  it("still sets the MAIL FROM domain in SES mode", async () => {
    mockEnv.EMAIL_PROVIDER = "ses";
    await addDomain("mail.example.com", "us-east-1");

    expect(
      sentCommands().some(
        (cmd) => cmd instanceof PutEmailIdentityMailFromAttributesCommand,
      ),
    ).toBe(true);
  });
});
