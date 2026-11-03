import type { EventType } from "@aws-sdk/client-sesv2";
import { env } from "~/env";

/**
 * Yandex Cloud Postbox support.
 *
 * Postbox speaks the SES v2 API, but has no SNS: delivery events go to a
 * Yandex Data Streams (YDS) stream through a `KinesisFirehoseDestination`.
 * It also does not support custom MAIL FROM domains, `GetAccount` and the
 * `REJECT` event type.
 */

export const POSTBOX_SES_ENDPOINT = "https://postbox.cloud.yandex.net";
export const POSTBOX_SPF_INCLUDE = "spf.postbox.yandexcloud.net";

const POSTBOX_UNSUPPORTED_EVENTS: EventType[] = ["REJECT"];

export function isPostbox() {
  return env.EMAIL_PROVIDER === "postbox";
}

export function filterSupportedEventTypes(eventTypes: EventType[]) {
  if (!isPostbox()) {
    return eventTypes;
  }
  return eventTypes.filter(
    (eventType) => !POSTBOX_UNSUPPORTED_EVENTS.includes(eventType),
  );
}

/**
 * Builds the `DeliveryStreamArn` Postbox expects for a YDS stream:
 * `arn:yc:yds:<region>::<endpoint><database path>:<stream name>`.
 *
 * `POSTBOX_YDS_STREAM` is the full stream path as shown in the YDS console,
 * e.g. `/ru-central1/<cloud id>/<database id>/<stream name>`.
 */
export function getPostboxStreamArn(region: string) {
  const streamPath = getPostboxStreamPath();
  const separator = streamPath.lastIndexOf("/");
  const databasePath = streamPath.slice(0, separator);
  const streamName = streamPath.slice(separator + 1);
  const endpoint = env.POSTBOX_YDS_ENDPOINT.replace(/\/+$/, "");

  return `arn:yc:yds:${region}::${endpoint}${databasePath}:${streamName}`;
}

export function getPostboxStreamPath() {
  const raw = env.POSTBOX_YDS_STREAM?.trim();
  if (!raw) {
    throw new Error(
      "POSTBOX_YDS_STREAM is required when EMAIL_PROVIDER=postbox",
    );
  }

  const streamPath = raw.startsWith("/") ? raw : `/${raw}`;
  const separator = streamPath.lastIndexOf("/");
  if (separator <= 0 || separator === streamPath.length - 1) {
    throw new Error(
      "POSTBOX_YDS_STREAM must be the full stream path, e.g. /ru-central1/<cloud id>/<database id>/<stream name>",
    );
  }

  return streamPath;
}
