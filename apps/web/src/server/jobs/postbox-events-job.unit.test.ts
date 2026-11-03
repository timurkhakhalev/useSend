import { describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({
  env: {
    EMAIL_PROVIDER: "postbox",
    POSTBOX_YDS_ENDPOINT: "https://yds.serverless.yandexcloud.net",
    POSTBOX_YDS_STREAM: "/ru-central1/cloud-1/db-1/postbox-events",
    AWS_DEFAULT_REGION: "ru-central1",
  },
}));
vi.mock("~/server/redis", () => ({
  BULL_PREFIX: "bull",
  getRedis: vi.fn(),
  redisKey: (key: string) => key,
}));
vi.mock("~/server/service/ses-hook-parser", () => ({
  SesHookParser: { queue: vi.fn() },
}));

import {
  decodeMimeWords,
  parsePostboxRecord,
} from "~/server/jobs/postbox-events-job";

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("postbox events job", () => {
  it("decodes RFC 2047 base64 and quoted-printable words", () => {
    expect(decodeMimeWords("=?UTF-8?B?0J/RgNC40LLQtdGC?=")).toBe("Привет");
    expect(decodeMimeWords("=?utf-8?Q?Hello_=D0=BC=D0=B8=D1=80?=")).toBe(
      "Hello мир",
    );
    expect(decodeMimeWords("=?utf-8?B?0J/RgA==?= =?utf-8?B?0LjQstC10YI=?=")).toBe(
      "Привет",
    );
    expect(decodeMimeWords("plain")).toBe("plain");
  });

  it("parses an SES-shaped Postbox event and decodes headers", () => {
    const event = parsePostboxRecord(
      encode({
        eventId: "ev-1",
        eventType: "Delivery",
        mail: {
          messageId: "msg-1",
          headers: [
            { name: "X-Usesend-Email-ID", value: "email-1" },
            { name: "Subject", value: "=?UTF-8?B?0J/RgNC40LLQtdGC?=" },
          ],
          commonHeaders: { subject: "=?UTF-8?B?0J/RgNC40LLQtdGC?=" },
        },
        delivery: {},
      }),
    );

    expect(event?.eventId).toBe("ev-1");
    expect(event?.mail.headers[1]?.value).toBe("Привет");
    expect(event?.mail.commonHeaders.subject).toBe("Привет");
  });

  it("skips records that are not events", () => {
    expect(parsePostboxRecord(encode({ test: 1 }))).toBeNull();
    expect(parsePostboxRecord(new TextEncoder().encode("not json"))).toBeNull();
  });
});
