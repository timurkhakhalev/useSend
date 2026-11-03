import dns from "dns";
import util from "util";
import * as tldts from "tldts";
import * as ses from "~/server/aws/ses";
import { isPostbox, POSTBOX_SPF_INCLUDE } from "~/server/aws/postbox";
import { db } from "~/server/db";
import { env } from "~/env";
import { renderDomainVerificationStatusEmail } from "~/server/email-templates";
import { logger } from "~/server/logger/log";
import { sendMail } from "~/server/mailer";
import { getRedis, redisKey } from "~/server/redis";
import { SesSettingsService } from "./ses-settings-service";
import { UnsendApiError } from "../public-api/api-error";
import { ApiKey, DomainStatus, type Domain } from "@prisma/client";
import {
  type DomainPayload,
  type DomainWebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";
import { LimitService } from "./limit-service";
import type { DomainDnsRecord } from "~/types/domain";
import { parseFromAddress } from "~/server/utils/from-address";
import { WebhookService } from "./webhook-service";
import { decryptSecret, encryptSecret } from "~/server/utils/secret-encryption";

const DOMAIN_STATUS_VALUES = new Set(Object.values(DomainStatus));
export const DOMAIN_UNVERIFIED_RECHECK_MS = 6 * 60 * 60 * 1000;
export const DOMAIN_VERIFIED_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFIED_DOMAIN_STATUSES = new Set<DomainStatus>([DomainStatus.SUCCESS]);
const DKIM_KEY_ENCRYPTION_PURPOSE = "domain-dkim-private-key";
export const POSTBOX_RECREATE_COOLDOWN_SECONDS = 10 * 60;
export const POSTBOX_RECREATE_MAX_PER_DAY = 5;

type DomainVerificationState = {
  hasEverVerified: boolean;
  lastCheckedAt: Date | null;
  lastNotifiedStatus: DomainStatus | null;
};

type DomainWithDnsRecords = Domain & { dnsRecords: DomainDnsRecord[] };

type DomainVerificationRefreshResult = DomainWithDnsRecords & {
  verificationError: string | null;
  lastCheckedTime: string | null;
  previousStatus: DomainStatus;
  statusChanged: boolean;
  hasEverVerified: boolean;
};

function parseDomainStatus(status?: string | null): DomainStatus {
  if (!status) {
    return DomainStatus.NOT_STARTED;
  }

  const normalized = status.toUpperCase();

  if (DOMAIN_STATUS_VALUES.has(normalized as DomainStatus)) {
    return normalized as DomainStatus;
  }

  return DomainStatus.NOT_STARTED;
}

/**
 * Postbox signs with the BYODKIM key and has no custom MAIL FROM domain, so
 * SPF goes on the sending domain itself and there is no MX record.
 */
export function getPostboxDkimRecordValue(publicKey: string) {
  // Postbox only accepts this exact format; "v=DKIM1; k=rsa; p=..." fails.
  return `v=DKIM1;h=sha256;k=rsa;p=${publicKey}`;
}

function buildPostboxDnsRecords(domain: Domain): DomainDnsRecord[] {
  const subdomainSuffix = domain.subdomain ? `.${domain.subdomain}` : "";
  const dkimSelector = domain.dkimSelector ?? "usesend";
  const spfStatus = parseDomainStatus(domain.spfDetails);
  const dkimStatus = parseDomainStatus(domain.dkimStatus);
  const dmarcStatus = domain.dmarcAdded
    ? DomainStatus.SUCCESS
    : DomainStatus.NOT_STARTED;

  return [
    {
      type: "TXT",
      name: `${dkimSelector}._domainkey${subdomainSuffix}`,
      value: getPostboxDkimRecordValue(domain.publicKey),
      ttl: "Auto",
      status: dkimStatus,
    },
    {
      type: "TXT",
      name: domain.subdomain ?? "@",
      value: `v=spf1 include:${POSTBOX_SPF_INCLUDE} ~all`,
      ttl: "Auto",
      status: spfStatus,
    },
    {
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=none;",
      ttl: "Auto",
      status: dmarcStatus,
      recommended: true,
    },
  ];
}

function buildDnsRecords(domain: Domain): DomainDnsRecord[] {
  if (isPostbox()) {
    return buildPostboxDnsRecords(domain);
  }

  const subdomainSuffix = domain.subdomain ? `.${domain.subdomain}` : "";
  const mailDomain = `mail${subdomainSuffix}`;
  const dkimSelector = domain.dkimSelector ?? "usesend";

  const spfStatus = parseDomainStatus(domain.spfDetails);
  const dkimStatus = parseDomainStatus(domain.dkimStatus);
  const dmarcStatus = domain.dmarcAdded
    ? DomainStatus.SUCCESS
    : DomainStatus.NOT_STARTED;

  return [
    {
      type: "MX",
      name: mailDomain,
      value: `feedback-smtp.${domain.region}.amazonses.com`,
      ttl: "Auto",
      priority: "10",
      status: spfStatus,
    },
    {
      type: "TXT",
      name: `${dkimSelector}._domainkey${subdomainSuffix}`,
      value: `p=${domain.publicKey}`,
      ttl: "Auto",
      status: dkimStatus,
    },
    {
      type: "TXT",
      name: mailDomain,
      value: "v=spf1 include:amazonses.com ~all",
      ttl: "Auto",
      status: spfStatus,
    },
    {
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=none;",
      ttl: "Auto",
      status: dmarcStatus,
      recommended: true,
    },
  ];
}

function withDnsRecords<T extends Domain>(
  domain: T,
): T & { dnsRecords: DomainDnsRecord[] } {
  return {
    ...domain,
    dnsRecords: buildDnsRecords(domain),
  };
}

const dnsResolveTxt = util.promisify(dns.resolveTxt);

function getDomainVerificationKey(kind: string, domainId: number) {
  return redisKey(`domain:verification:${kind}:${domainId}`);
}

function normalizeDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getDomainVerificationState(
  domainId: number,
): Promise<DomainVerificationState> {
  const redis = getRedis();
  const [lastCheckedValue, lastNotifiedStatusValue, hasEverVerifiedValue] =
    await redis.mget([
      getDomainVerificationKey("last-check", domainId),
      getDomainVerificationKey("last-notified-status", domainId),
      getDomainVerificationKey("has-ever-verified", domainId),
    ]);

  return {
    hasEverVerified: hasEverVerifiedValue === "1",
    lastCheckedAt: normalizeDate(lastCheckedValue),
    lastNotifiedStatus: DOMAIN_STATUS_VALUES.has(
      (lastNotifiedStatusValue ?? "") as DomainStatus,
    )
      ? (lastNotifiedStatusValue as DomainStatus)
      : null,
  };
}

async function setDomainVerificationCheckedAt(
  domainId: number,
  checkedAt: Date,
) {
  await getRedis().set(
    getDomainVerificationKey("last-check", domainId),
    checkedAt.toISOString(),
  );
}

async function markDomainEverVerified(domainId: number) {
  await getRedis().set(
    getDomainVerificationKey("has-ever-verified", domainId),
    "1",
  );
}

async function setLastNotifiedDomainStatus(
  domainId: number,
  status: DomainStatus,
) {
  await getRedis().set(
    getDomainVerificationKey("last-notified-status", domainId),
    status,
  );
}

async function reserveDomainStatusNotification(
  domainId: number,
  status: DomainStatus,
) {
  const result = await getRedis().set(
    getDomainVerificationKey(`notification-lock:${status}`, domainId),
    "1",
    "EX",
    300,
    "NX",
  );

  return result === "OK";
}

async function clearDomainVerificationState(domainId: number) {
  await getRedis().del(
    getDomainVerificationKey("last-check", domainId),
    getDomainVerificationKey("last-notified-status", domainId),
    getDomainVerificationKey("has-ever-verified", domainId),
  );
}

function shouldContinueVerifying(
  verificationStatus: DomainStatus,
  dkimStatus: string | undefined,
  spfDetails: string | undefined,
) {
  if (
    verificationStatus === DomainStatus.SUCCESS &&
    dkimStatus === DomainStatus.SUCCESS &&
    spfDetails === DomainStatus.SUCCESS
  ) {
    return false;
  }

  return verificationStatus !== DomainStatus.FAILED;
}

function shouldSendDomainStatusNotification({
  previousStatus,
  currentStatus,
  hasEverVerified,
  lastNotifiedStatus,
}: {
  previousStatus: DomainStatus;
  currentStatus: DomainStatus;
  hasEverVerified: boolean;
  lastNotifiedStatus: DomainStatus | null;
}) {
  if (lastNotifiedStatus === null && currentStatus === previousStatus) {
    return false;
  }

  if (hasEverVerified) {
    return currentStatus !== lastNotifiedStatus;
  }

  if (
    currentStatus !== DomainStatus.SUCCESS &&
    currentStatus !== DomainStatus.FAILED
  ) {
    return false;
  }

  return currentStatus !== lastNotifiedStatus;
}

async function sendDomainStatusNotification({
  domain,
  previousStatus,
}: {
  domain: Domain;
  previousStatus: DomainStatus;
}) {
  const recipients = (
    await db.teamUser.findMany({
      where: {
        teamId: domain.teamId,
      },
      include: {
        user: true,
      },
    })
  )
    .map((teamUser) => teamUser.user?.email)
    .filter((email): email is string => Boolean(email));

  if (recipients.length === 0) {
    logger.info(
      { domainId: domain.id, teamId: domain.teamId },
      "[DomainService]: Skipping domain status email because team has no recipients",
    );
    return;
  }

  const subject =
    domain.status === DomainStatus.SUCCESS
      ? `useSend: ${domain.name} is verified`
      : previousStatus === DomainStatus.SUCCESS
        ? `useSend: ${domain.name} verification status changed`
        : `useSend: ${domain.name} verification failed`;

  const domainUrl = `${env.NEXTAUTH_URL}/domains/${domain.id}`;
  const html = await renderDomainVerificationStatusEmail({
    domainName: domain.name,
    currentStatus: domain.status,
    previousStatus,
    domainUrl,
  });
  const statusMessage =
    domain.status === DomainStatus.SUCCESS
      ? `Your domain ${domain.name} is now verified, and you can start sending emails.`
      : `Your domain ${domain.name} could not be verified because the DNS records are not set up correctly yet. Please review your DNS settings and try again.`;
  const textLines = [
    "Hey,",
    null,
    statusMessage,
    null,
    `Open domain settings: ${domainUrl}`,
    null,
    "Thanks,",
    "useSend Team",
  ].filter((value): value is string => Boolean(value));

  await Promise.all(
    recipients.map((email) =>
      sendMail(email, subject, textLines.join("\n"), html, "hey@usesend.com"),
    ),
  );
}

function buildDomainPayload(domain: Domain): DomainPayload {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    region: domain.region,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
    clickTracking: domain.clickTracking,
    openTracking: domain.openTracking,
    subdomain: domain.subdomain,
    sesTenantId: domain.sesTenantId,
    dkimStatus: domain.dkimStatus,
    spfDetails: domain.spfDetails,
    dmarcAdded: domain.dmarcAdded,
  };
}

export async function validateDomainFromEmail(email: string, teamId: number) {
  const fromDomain = parseFromAddress(email)?.domain;

  if (!fromDomain) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "From email is invalid",
    });
  }

  const domain = await db.domain.findFirst({
    where: { name: fromDomain, teamId },
  });

  if (!domain) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Domain: ${fromDomain} of from email is wrong. Use the domain verified by useSend`,
    });
  }

  if (domain.status !== "SUCCESS") {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Domain: ${fromDomain} is not verified`,
    });
  }

  return domain;
}

export async function validateApiKeyDomainAccess(
  email: string,
  teamId: number,
  apiKey: ApiKey & { domain?: { name: string } | null },
) {
  // First validate the domain exists and is verified
  const domain = await validateDomainFromEmail(email, teamId);

  // If API key has no domain restriction (domainId is null), allow all domains
  if (!apiKey.domainId) {
    return domain;
  }

  // If API key is restricted to a specific domain, check if it matches
  if (apiKey.domainId !== domain.id) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: `API key does not have access to domain: ${domain.name}`,
    });
  }

  return domain;
}

export async function createDomain(
  teamId: number,
  name: string,
  region: string,
  sesTenantId?: string,
) {
  const domainStr = tldts.getDomain(name);

  logger.info({ domainStr, name, region }, "Creating domain");

  if (!domainStr) {
    throw new Error("Invalid domain");
  }

  const setting = await SesSettingsService.getSetting(region);

  if (!setting) {
    throw new Error("Ses setting not found");
  }

  const { isLimitReached, reason } =
    await LimitService.checkDomainLimit(teamId);

  if (isLimitReached) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: reason ?? "Domain limit reached",
    });
  }

  const subdomain = tldts.getSubdomain(name);
  const dkimSelector = "usesend";
  const { publicKey, privateKey } = await ses.addDomain(
    name,
    region,
    sesTenantId,
    dkimSelector,
  );
  const encryptedPrivateKey = isPostbox()
    ? encryptSecret(privateKey, DKIM_KEY_ENCRYPTION_PURPOSE)
    : undefined;

  const domain = await db.domain.create({
    data: {
      name,
      publicKey,
      ...(encryptedPrivateKey
        ? { dkimKey: { create: { encryptedPrivateKey } } }
        : {}),
      teamId,
      subdomain,
      region,
      sesTenantId,
      dkimSelector,
      dkimStatus: DomainStatus.NOT_STARTED,
      spfDetails: DomainStatus.NOT_STARTED,
    },
  });

  await emitDomainEvent(domain, "domain.created");

  return withDnsRecords(domain);
}

export async function getDomain(id: number, teamId: number) {
  let domain = await db.domain.findUnique({
    where: {
      id,
      teamId,
    },
  });

  if (!domain) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Domain not found",
    });
  }

  if (domain.isVerifying) {
    return refreshDomainVerification(domain);
  }

  return withDnsRecords(domain);
}

export async function refreshDomainVerification(
  domainOrId: number | Domain,
): Promise<DomainVerificationRefreshResult> {
  const domain =
    typeof domainOrId === "number"
      ? await db.domain.findUnique({ where: { id: domainOrId } })
      : domainOrId;

  if (!domain) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Domain not found",
    });
  }

  const verificationState = await getDomainVerificationState(domain.id);
  const previousStatus = domain.status;
  let domainIdentity: Awaited<ReturnType<typeof ses.getDomainIdentity>>;
  let recreatedIdentity: typeof domainIdentity | null = null;
  try {
    domainIdentity = await ses.getDomainIdentity(domain.name, domain.region);
  } catch (error) {
    // A recreate that deleted the identity but failed to create it again
    // leaves no identity behind; try to restore it.
    const isMissing =
      error instanceof Error && error.name === "NotFoundException";
    recreatedIdentity =
      isPostbox() && isMissing
        ? await maybeRecreatePostboxIdentity(domain, DomainStatus.FAILED)
        : null;
    if (!recreatedIdentity) {
      throw error;
    }
    domainIdentity = recreatedIdentity;
  }
  if (isPostbox() && !recreatedIdentity) {
    recreatedIdentity = await maybeRecreatePostboxIdentity(
      domain,
      domainIdentity.DkimAttributes?.Status?.toString(),
    );
    domainIdentity = recreatedIdentity ?? domainIdentity;
  }
  const dkimStatus = domainIdentity.DkimAttributes?.Status?.toString();
  const spfDetails = isPostbox()
    ? await getPostboxSpfStatus(domain.name)
    : domainIdentity.MailFromAttributes?.MailFromDomainStatus?.toString();
  const verificationError =
    domainIdentity.VerificationInfo?.ErrorType?.toString() ?? null;
  const verificationStatus = parseDomainStatus(
    domainIdentity.VerificationStatus?.toString(),
  );
  const lastCheckedTime = domainIdentity.VerificationInfo?.LastCheckedTimestamp;
  const baseDomain = tldts.getDomain(domain.name);
  const _dmarcRecord = baseDomain ? await getDmarcRecord(baseDomain) : null;
  const dmarcRecord = _dmarcRecord?.[0]?.[0];
  const checkedAt = new Date();

  const updatedDomain = await db.domain.update({
    where: {
      id: domain.id,
    },
    data: {
      dkimStatus: dkimStatus ?? null,
      spfDetails: spfDetails ?? null,
      status: verificationStatus,
      errorMessage: verificationError,
      dmarcAdded: Boolean(dmarcRecord),
      isVerifying: shouldContinueVerifying(
        verificationStatus,
        dkimStatus,
        spfDetails,
      ),
    },
  });

  await setDomainVerificationCheckedAt(domain.id, checkedAt);

  if (updatedDomain.status === DomainStatus.SUCCESS) {
    await markDomainEverVerified(domain.id);
  }

  if (
    // A recreated Postbox identity is in a transient state; wait for the
    // next check instead of notifying about it.
    !recreatedIdentity &&
    shouldSendDomainStatusNotification({
      previousStatus,
      currentStatus: updatedDomain.status,
      hasEverVerified:
        verificationState.hasEverVerified ||
        updatedDomain.status === DomainStatus.SUCCESS,
      lastNotifiedStatus: verificationState.lastNotifiedStatus,
    })
  ) {
    const reservedNotification = await reserveDomainStatusNotification(
      domain.id,
      updatedDomain.status,
    );

    if (reservedNotification) {
      try {
        await sendDomainStatusNotification({
          domain: updatedDomain,
          previousStatus,
        });
        await setLastNotifiedDomainStatus(domain.id, updatedDomain.status);
      } catch (error) {
        logger.error(
          { err: error, domainId: domain.id, status: updatedDomain.status },
          "[DomainService]: Failed to send domain status notification",
        );
      }
    }
  }

  const normalizedDomain = {
    ...updatedDomain,
    dkimStatus: dkimStatus ?? null,
    spfDetails: spfDetails ?? null,
    dmarcAdded: Boolean(dmarcRecord),
  } satisfies Domain;

  const domainWithDns = withDnsRecords(normalizedDomain);
  const normalizedLastCheckedTime =
    lastCheckedTime instanceof Date
      ? lastCheckedTime.toISOString()
      : lastCheckedTime != null
        ? String(lastCheckedTime)
        : null;

  if (previousStatus !== domainWithDns.status) {
    const eventType: DomainWebhookEventType =
      domainWithDns.status === DomainStatus.SUCCESS
        ? "domain.verified"
        : "domain.updated";
    await emitDomainEvent(domainWithDns, eventType);
  }

  return {
    ...domainWithDns,
    dkimStatus: normalizedDomain.dkimStatus,
    spfDetails: normalizedDomain.spfDetails,
    verificationError,
    lastCheckedTime: normalizedLastCheckedTime,
    dmarcAdded: normalizedDomain.dmarcAdded,
    previousStatus,
    statusChanged: previousStatus !== domainWithDns.status,
    hasEverVerified:
      verificationState.hasEverVerified ||
      domainWithDns.status === DomainStatus.SUCCESS,
  };
}

export async function updateDomain(
  id: number,
  data: { clickTracking?: boolean; openTracking?: boolean },
) {
  const updated = await db.domain.update({
    where: { id },
    data,
  });

  await emitDomainEvent(updated, "domain.updated");

  return updated;
}

export async function deleteDomain(id: number) {
  const domain = await db.domain.findUnique({
    where: { id },
  });

  if (!domain) {
    throw new Error("Domain not found");
  }

  const deleted = await ses.deleteDomain(
    domain.name,
    domain.region,
    domain.sesTenantId ?? undefined,
  );

  if (!deleted) {
    throw new Error("Error in deleting domain");
  }

  const deletedRecord = await db.domain.delete({ where: { id } });
  try {
    await clearDomainVerificationState(id);
  } catch (error) {
    logger.error(
      { err: error, domainId: id },
      "[DomainService]: Failed to clear domain verification state",
    );
  }

  await emitDomainEvent(domain, "domain.deleted");

  return deletedRecord;
}

export async function getDomains(
  teamId: number,
  options?: { domainId?: number },
) {
  const domains = await db.domain.findMany({
    where: {
      teamId,
      ...(options?.domainId ? { id: options.domainId } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return domains.map((d) => withDnsRecords(d));
}

/**
 * Postbox checks DKIM once, right after the identity is created, and never
 * again. When the check failed (usually because the record was added later)
 * but the record is now correct, delete and recreate the identity with the
 * stored key so Postbox checks again.
 *
 * Returns the fresh identity, or null when nothing was done. Guarded by a
 * per-domain cooldown and a daily cap so a domain that keeps failing cannot
 * loop or hit Postbox rate limits.
 */
async function maybeRecreatePostboxIdentity(
  domain: Domain,
  dkimStatus: string | undefined,
) {
  if (dkimStatus !== DomainStatus.FAILED) {
    return null;
  }

  const dkimKey = await db.domainDkimKey.findUnique({
    where: { domainId: domain.id },
  });
  if (!dkimKey) {
    // Domains created before keys were stored cannot be recreated.
    return null;
  }

  const selector = domain.dkimSelector ?? "usesend";
  const recordName = `${selector}._domainkey.${domain.name}`;
  const expected = getPostboxDkimRecordValue(domain.publicKey);
  let records: string[][];
  try {
    records = await dnsResolveTxt(recordName);
  } catch (error) {
    logger.info(
      { err: error, domainId: domain.id, recordName },
      "[DomainService]: DKIM record not found, not recreating Postbox identity",
    );
    return null;
  }
  if (!records.some((chunks) => chunks.join("").trim() === expected)) {
    return null;
  }

  const redis = getRedis();
  const cooldown = await redis.set(
    getDomainVerificationKey("postbox-recreate-lock", domain.id),
    "1",
    "EX",
    POSTBOX_RECREATE_COOLDOWN_SECONDS,
    "NX",
  );
  if (cooldown !== "OK") {
    return null;
  }

  const countKey = getDomainVerificationKey(
    "postbox-recreate-count",
    domain.id,
  );
  const attempts = await redis.incr(countKey);
  if (attempts === 1) {
    await redis.expire(countKey, 24 * 60 * 60);
  }
  if (attempts > POSTBOX_RECREATE_MAX_PER_DAY) {
    logger.warn(
      { domainId: domain.id, attempts },
      "[DomainService]: Postbox identity recreated too often today, skipping",
    );
    return null;
  }

  let privateKey: string;
  try {
    privateKey = decryptSecret(
      dkimKey.encryptedPrivateKey,
      DKIM_KEY_ENCRYPTION_PURPOSE,
    );
  } catch (error) {
    logger.error(
      { err: error, domainId: domain.id },
      "[DomainService]: Cannot decrypt the stored DKIM key (was NEXTAUTH_SECRET changed?)",
    );
    return null;
  }

  logger.info(
    { domainId: domain.id, attempts },
    "[DomainService]: DKIM failed but the record is correct, recreating Postbox identity",
  );
  await ses.recreateDomainIdentity(
    domain.name,
    domain.region,
    selector,
    privateKey,
  );

  return ses.getDomainIdentity(domain.name, domain.region);
}

/**
 * Postbox does not report SPF status, so check the domain's TXT records.
 */
async function getPostboxSpfStatus(domain: string): Promise<DomainStatus> {
  try {
    const records = await dnsResolveTxt(domain);
    const hasPostboxSpf = records
      .map((chunks) => chunks.join(""))
      .some(
        (record) =>
          record.toLowerCase().startsWith("v=spf1") &&
          record.includes(`include:${POSTBOX_SPF_INCLUDE}`),
      );
    return hasPostboxSpf ? DomainStatus.SUCCESS : DomainStatus.PENDING;
  } catch (error) {
    logger.info({ err: error, domain }, "No SPF record found for domain");
    return DomainStatus.PENDING;
  }
}

async function getDmarcRecord(domain: string) {
  try {
    const dmarcRecord = await dnsResolveTxt(`_dmarc.${domain}`);
    return dmarcRecord;
  } catch (error) {
    logger.error({ err: error, domain }, "Error fetching DMARC record");
    return null; // or handle error as appropriate
  }
}

async function emitDomainEvent(domain: Domain, type: DomainWebhookEventType) {
  try {
    await WebhookService.emit(domain.teamId, type, buildDomainPayload(domain), {
      domainId: domain.id,
    });
  } catch (error) {
    logger.error(
      { error, domainId: domain.id, type },
      "[DomainService]: Failed to emit domain webhook event",
    );
  }
}

export async function isDomainVerificationDue(domain: Domain) {
  const verificationState = await getDomainVerificationState(domain.id);

  if (
    !verificationState.hasEverVerified &&
    domain.status === DomainStatus.FAILED &&
    !domain.isVerifying
  ) {
    return false;
  }

  const now = Date.now();
  const lastCheckedAt = verificationState.lastCheckedAt?.getTime() ?? 0;
  const intervalMs =
    verificationState.hasEverVerified ||
    VERIFIED_DOMAIN_STATUSES.has(domain.status)
      ? DOMAIN_VERIFIED_RECHECK_MS
      : DOMAIN_UNVERIFIED_RECHECK_MS;

  if (!verificationState.lastCheckedAt) {
    return true;
  }

  return now - lastCheckedAt >= intervalMs;
}
