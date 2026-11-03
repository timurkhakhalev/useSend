import {
  GetRecordsCommand,
  GetShardIteratorCommand,
  KinesisClient,
  ListShardsCommand,
  type _Record,
} from "@aws-sdk/client-kinesis";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Queue, Worker } from "bullmq";
import { env } from "~/env";
import { getAwsCredentialOptions } from "~/server/aws/credentials";
import { getPostboxStreamPath, isPostbox } from "~/server/aws/postbox";
import { logger } from "~/server/logger/log";
import {
  DEFAULT_QUEUE_OPTIONS,
  POSTBOX_EVENTS_QUEUE,
} from "~/server/queue/queue-constants";
import { BULL_PREFIX, getRedis, redisKey } from "~/server/redis";
import { SesHookParser } from "~/server/service/ses-hook-parser";
import type { SesEvent } from "~/types/aws-types";

/**
 * Reads Postbox delivery events from the Yandex Data Streams stream and feeds
 * them to the existing SES hook parser.
 *
 * Postbox has no SNS: events go to a YDS stream, which speaks the Kinesis
 * API. A BullMQ scheduler with a single-concurrency worker polls the stream,
 * so only one reader runs even with several app instances. The last read
 * sequence number per shard is kept in Redis. Delivery is at-least-once, so
 * events are de-duplicated by `eventId` (or by the record sequence number).
 */

const POLL_INTERVAL_MS = 5_000;
const MAX_PAGES_PER_RUN = 20;
const RECORDS_PER_PAGE = 500;
const DEDUPE_TTL_SECONDS = 3 * 24 * 3600;

let kinesisClient: KinesisClient | undefined;
let initialized = false;

function getKinesisClient() {
  if (!kinesisClient) {
    kinesisClient = new KinesisClient({
      region: env.AWS_DEFAULT_REGION,
      endpoint: env.POSTBOX_YDS_ENDPOINT,
      // YDS fails over HTTP/2 ("Protocol error"); force HTTP/1.1.
      requestHandler: new NodeHttpHandler(),
      ...getAwsCredentialOptions(),
    });
  }
  return kinesisClient;
}

function checkpointKey(streamName: string, shardId: string) {
  return redisKey(`postbox:yds:${streamName}:${shardId}:seq`);
}

function dedupeKey(id: string) {
  return redisKey(`postbox:event:${id}`);
}

type PostboxEvent = SesEvent & { eventId?: string };

export function parsePostboxRecord(data: Uint8Array): PostboxEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as PostboxEvent).eventType !== "string" ||
    typeof (payload as PostboxEvent).mail?.messageId !== "string"
  ) {
    return null;
  }

  const event = payload as PostboxEvent;
  event.mail.headers = (event.mail.headers ?? []).map((header) => ({
    ...header,
    value: decodeMimeWords(header.value),
  }));
  if (event.mail.commonHeaders?.subject) {
    event.mail.commonHeaders.subject = decodeMimeWords(
      event.mail.commonHeaders.subject,
    );
  }

  return event;
}

/** Decodes RFC 2047 encoded words (`=?utf-8?B?...?=`) that Postbox leaves in headers. */
export function decodeMimeWords(value: string) {
  if (typeof value !== "string" || !value.includes("=?")) {
    return value;
  }

  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (match, charset: string, encoding: string, text: string) => {
        try {
          const bytes =
            encoding.toUpperCase() === "B"
              ? Buffer.from(text, "base64")
              : Buffer.from(
                  text
                    .replace(/_/g, " ")
                    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  "binary",
                );
          return new TextDecoder(charset.toLowerCase()).decode(bytes);
        } catch {
          return match;
        }
      },
    );
}

async function handleRecord(record: _Record) {
  if (!record.Data) {
    return;
  }

  const event = parsePostboxRecord(record.Data);
  if (!event) {
    logger.warn(
      { sequenceNumber: record.SequenceNumber },
      "[PostboxEventsJob]: Skipping record that is not a Postbox event",
    );
    return;
  }

  const id = event.eventId ?? `seq-${record.SequenceNumber}`;
  const isNew = await getRedis().set(
    dedupeKey(id),
    "1",
    "EX",
    DEDUPE_TTL_SECONDS,
    "NX",
  );
  if (!isNew) {
    return;
  }

  try {
    await SesHookParser.queue({ event, messageId: id });
  } catch (error) {
    await getRedis().del(dedupeKey(id));
    throw error;
  }
}

async function readShard(streamName: string, shardId: string) {
  const client = getKinesisClient();
  const redis = getRedis();
  const key = checkpointKey(streamName, shardId);
  const lastSequence = await redis.get(key);

  const iterator = await client.send(
    new GetShardIteratorCommand({
      StreamName: streamName,
      ShardId: shardId,
      ...(lastSequence
        ? {
            ShardIteratorType: "AFTER_SEQUENCE_NUMBER",
            StartingSequenceNumber: lastSequence,
          }
        : { ShardIteratorType: "TRIM_HORIZON" }),
    }),
  );

  let shardIterator = iterator.ShardIterator;
  let processed = 0;

  for (let page = 0; shardIterator && page < MAX_PAGES_PER_RUN; page++) {
    const response = await client.send(
      new GetRecordsCommand({
        ShardIterator: shardIterator,
        Limit: RECORDS_PER_PAGE,
      }),
    );

    for (const record of response.Records ?? []) {
      await handleRecord(record);
      if (record.SequenceNumber) {
        await redis.set(key, record.SequenceNumber);
      }
      processed++;
    }

    if (!response.Records?.length || !response.MillisBehindLatest) {
      break;
    }
    shardIterator = response.NextShardIterator;
  }

  return processed;
}

export async function pollPostboxEvents() {
  const streamName = getPostboxStreamPath();
  const shards = await getKinesisClient().send(
    new ListShardsCommand({ StreamName: streamName }),
  );

  let processed = 0;
  for (const shard of shards.Shards ?? []) {
    if (shard.ShardId) {
      processed += await readShard(streamName, shard.ShardId);
    }
  }

  if (processed > 0) {
    logger.info({ processed }, "[PostboxEventsJob]: Read stream records");
  }
}

export async function initPostboxEventsJob() {
  if (initialized || !isPostbox() || !env.POSTBOX_YDS_STREAM) {
    return;
  }

  const connection = getRedis();
  const queue = new Queue(POSTBOX_EVENTS_QUEUE, {
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  const worker = new Worker(
    POSTBOX_EVENTS_QUEUE,
    async () => {
      await pollPostboxEvents();
    },
    {
      connection,
      concurrency: 1,
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
    },
  );

  await queue.upsertJobScheduler(
    "postbox-events-poll",
    { every: POLL_INTERVAL_MS },
    {
      opts: {
        ...DEFAULT_QUEUE_OPTIONS,
        removeOnFail: { count: 100 },
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "[PostboxEventsJob]: Poll failed");
  });

  initialized = true;
  logger.info("[PostboxEventsJob]: Polling Postbox events from YDS");
}
