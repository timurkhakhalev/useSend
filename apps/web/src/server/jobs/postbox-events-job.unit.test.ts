import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GetRecordsCommand,
  GetShardIteratorCommand,
  ListShardsCommand,
} from "@aws-sdk/client-kinesis";
import fixtures from "~/test/fixtures/postbox-events.json";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  queue: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@aws-sdk/client-kinesis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-kinesis")>()),
  KinesisClient: class {
    send = mocks.send;
  },
}));
vi.mock("~/env", () => ({ env: { AWS_DEFAULT_REGION: "ru-central1" } }));
vi.mock("~/server/aws/credentials", () => ({
  getAwsCredentialOptions: () => ({}),
}));
vi.mock("~/server/aws/postbox", () => ({
  getPostboxStreamPath: () => "/test/events",
  isPostbox: () => true,
}));
vi.mock("~/server/redis", () => ({
  getRedis: () => mocks,
  redisKey: (key: string) => key,
  BULL_PREFIX: "test",
}));
vi.mock("~/server/service/ses-hook-parser", () => ({
  SesHookParser: { queue: mocks.queue },
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  decodeMimeWords,
  parsePostboxRecord,
  pollPostboxEvents,
} from "./postbox-events-job";
const record = (sequence: string, event: unknown = fixtures.Bounce) => ({
  SequenceNumber: sequence,
  Data: Buffer.from(JSON.stringify(event)),
});
const checkpoint = "postbox:yds:/test/events:shard-1:seq";

beforeEach(() => {
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue("OK");
  mocks.queue.mockResolvedValue({});
});

function responses(records: unknown[], lastSequence: string | null = null) {
  mocks.get.mockResolvedValue(lastSequence);
  mocks.send
    .mockResolvedValueOnce({ Shards: [{ ShardId: "shard-1" }] })
    .mockResolvedValueOnce({ ShardIterator: "iterator-1" })
    .mockResolvedValueOnce({ Records: records, MillisBehindLatest: 0 });
}

describe("Postbox stream reader", () => {
  it.each([null, "99"])(
    "resumes from %s with the right iterator and checkpoints after enqueueing",
    async (sequence) => {
      responses([record("100")], sequence);
      await pollPostboxEvents();
      expect(mocks.send.mock.calls[0]![0]).toBeInstanceOf(ListShardsCommand);
      expect(mocks.send.mock.calls[1]![0]).toBeInstanceOf(
        GetShardIteratorCommand,
      );
      expect(mocks.send.mock.calls[1]![0].input).toEqual({
        StreamName: "/test/events",
        ShardId: "shard-1",
        ...(sequence
          ? {
              ShardIteratorType: "AFTER_SEQUENCE_NUMBER",
              StartingSequenceNumber: sequence,
            }
          : { ShardIteratorType: "TRIM_HORIZON" }),
      });
      expect(mocks.send.mock.calls[2]![0]).toBeInstanceOf(GetRecordsCommand);
      expect(mocks.queue).toHaveBeenCalledWith({
        event: fixtures.Bounce,
        messageId: fixtures.Bounce.eventId,
      });
      expect(mocks.set).toHaveBeenLastCalledWith(checkpoint, "100");
      expect(mocks.queue.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.set.mock.invocationCallOrder.at(-1)!,
      );
    },
  );

  it("skips duplicate events but advances their checkpoint", async () => {
    responses([record("100")]);
    mocks.set.mockResolvedValueOnce(null);
    await pollPostboxEvents();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenLastCalledWith(checkpoint, "100");
  });

  it("releases dedupe on enqueue failure and leaves the failed record uncheckpointed", async () => {
    responses([
      record("100"),
      record("101", { ...fixtures.Open, eventId: "second" }),
    ]);
    mocks.queue
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("queue down"));
    await expect(pollPostboxEvents()).rejects.toThrow("queue down");
    expect(mocks.set).toHaveBeenCalledWith(checkpoint, "100");
    expect(mocks.set).not.toHaveBeenCalledWith(checkpoint, "101");
    expect(mocks.del).toHaveBeenCalledWith("postbox:event:second");
  });

  it("continues through record pages and shard pages", async () => {
    mocks.send
      .mockResolvedValueOnce({
        Shards: [{ ShardId: "shard-1" }],
        NextToken: "next-shards",
      })
      .mockResolvedValueOnce({ ShardIterator: "it-1" })
      .mockResolvedValueOnce({
        Records: [record("100")],
        MillisBehindLatest: 1,
        NextShardIterator: "it-2",
      })
      .mockResolvedValueOnce({
        Records: [record("101", fixtures.Open)],
        MillisBehindLatest: 0,
      })
      .mockResolvedValueOnce({ Shards: [] });
    await pollPostboxEvents();
    expect(mocks.send.mock.calls[3]![0].input.ShardIterator).toBe("it-2");
    expect(mocks.send.mock.calls[4]![0].input).toEqual({
      NextToken: "next-shards",
    });
    expect(mocks.queue).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenLastCalledWith(checkpoint, "101");
  });

  it("uses shard-scoped sequence dedupe when eventId is absent", async () => {
    const { eventId, ...event } = fixtures.Open;
    responses([record("100", event)]);
    await pollPostboxEvents();
    expect(mocks.queue).toHaveBeenCalledWith({
      event,
      messageId: "seq-/test/events-shard-1-100",
    });
  });

  it("skips malformed records and tolerates an empty response", async () => {
    responses([{ SequenceNumber: "100", Data: Buffer.from("broken json") }]);
    await pollPostboxEvents();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(checkpoint, "100");
    responses([]);
    await pollPostboxEvents();
  });
});

describe("Postbox payloads", () => {
  it.each(Object.values(fixtures))(
    "accepts real anonymised $eventType events",
    (event) => {
      expect(parsePostboxRecord(Buffer.from(JSON.stringify(event)))).toEqual(
        event,
      );
    },
  );
  it.each(["null", "{}", "not json"])("rejects %s", (data) => {
    expect(parsePostboxRecord(Buffer.from(data))).toBeNull();
  });
  it("decodes MIME header words", () => {
    expect(decodeMimeWords("=?UTF-8?B?0J/RgNC40LLQtdGC?=")).toBe("Привет");
    expect(decodeMimeWords("=?UTF-8?Q?hello_world?=")).toBe("hello world");
  });
});

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("postbox events job", () => {
  it("decodes RFC 2047 base64 and quoted-printable words", () => {
    expect(decodeMimeWords("=?UTF-8?B?0J/RgNC40LLQtdGC?=")).toBe("Привет");
    expect(decodeMimeWords("=?utf-8?Q?Hello_=D0=BC=D0=B8=D1=80?=")).toBe(
      "Hello мир",
    );
    expect(
      decodeMimeWords("=?utf-8?B?0J/RgA==?= =?utf-8?B?0LjQstC10YI=?="),
    ).toBe("Привет");
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
