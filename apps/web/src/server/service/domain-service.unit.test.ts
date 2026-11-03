import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainStatus, type Domain } from "@prisma/client";

const {
  mockDb,
  mockGetDomainIdentity,
  mockWebhookEmit,
  mockRedis,
  mockSendMail,
  mockLoggerError,
  mockRenderDomainVerificationStatusEmail,
  mockResolveTxt,
  mockIsPostbox,
  mockRecreateDomainIdentity,
  mockAddDomain,
} = vi.hoisted(() => ({
  mockDb: {
    domain: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    teamUser: {
      findMany: vi.fn(),
    },
    domainDkimKey: {
      findUnique: vi.fn(),
    },
  },
  mockGetDomainIdentity: vi.fn(),
  mockWebhookEmit: vi.fn(),
  mockRedis: {
    mget: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
  },
  mockSendMail: vi.fn(),
  mockLoggerError: vi.fn(),
  mockRenderDomainVerificationStatusEmail: vi.fn(),
  mockResolveTxt: vi.fn(),
  mockIsPostbox: vi.fn(),
  mockRecreateDomainIdentity: vi.fn(),
  mockAddDomain: vi.fn(),
}));

function wasLastNotifiedStatusStored() {
  return mockRedis.set.mock.calls.some(
    (call) => call[0] === "domain:verification:last-notified-status:42",
  );
}

vi.mock("dns", () => ({
  default: {
    resolveTxt: mockResolveTxt,
  },
}));

vi.mock("~/server/db", () => ({
  db: mockDb,
}));

vi.mock("~/server/aws/ses", () => ({
  getDomainIdentity: mockGetDomainIdentity,
  recreateDomainIdentity: mockRecreateDomainIdentity,
  addDomain: mockAddDomain,
}));

vi.mock("./ses-settings-service", () => ({
  SesSettingsService: { getSetting: vi.fn(async () => ({ id: "setting-1" })) },
}));
vi.mock("./limit-service", () => ({
  LimitService: {
    checkDomainLimit: vi.fn(async () => ({ isLimitReached: false })),
  },
}));

vi.mock("~/env", () => ({
  env: { NEXTAUTH_SECRET: "test-secret", NEXTAUTH_URL: "https://x.test" },
}));

vi.mock("~/server/aws/postbox", () => ({
  isPostbox: mockIsPostbox,
  POSTBOX_SPF_INCLUDE: "spf.postbox.yandexcloud.net",
}));

vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {
    emit: mockWebhookEmit,
  },
}));

vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));

vi.mock("~/server/mailer", () => ({
  sendMail: mockSendMail,
}));

vi.mock("~/server/logger/log", () => ({
  logger: {
    error: mockLoggerError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("~/server/email-templates", () => ({
  renderDomainVerificationStatusEmail: mockRenderDomainVerificationStatusEmail,
}));

import {
  DOMAIN_UNVERIFIED_RECHECK_MS,
  DOMAIN_VERIFIED_RECHECK_MS,
  isDomainVerificationDue,
  refreshDomainVerification,
  createDomain as persistDomain,
  validateApiKeyDomainAccess,
  validateDomainFromEmail,
  POSTBOX_RECREATE_MAX_PER_DAY,
} from "~/server/service/domain-service";
import { decryptSecret, encryptSecret } from "~/server/utils/secret-encryption";

function createDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: 42,
    name: "example.com",
    teamId: 7,
    status: DomainStatus.PENDING,
    region: "us-east-1",
    clickTracking: false,
    openTracking: false,
    publicKey: "public-key",
    dkimSelector: "usesend",
    dkimStatus: DomainStatus.NOT_STARTED,
    spfDetails: DomainStatus.NOT_STARTED,
    dmarcAdded: false,
    errorMessage: null,
    subdomain: null,
    sesTenantId: null,
    isVerifying: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("domain-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    mockDb.domain.update.mockReset();
    mockDb.domain.findUnique.mockReset();
    mockDb.domain.findFirst.mockReset();
    mockDb.teamUser.findMany.mockReset();
    mockGetDomainIdentity.mockReset();
    mockWebhookEmit.mockReset();
    mockRedis.mget.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
    mockSendMail.mockReset();
    mockLoggerError.mockReset();
    mockRenderDomainVerificationStatusEmail.mockReset();
    mockResolveTxt.mockReset();
    mockIsPostbox.mockReset();
    mockIsPostbox.mockReturnValue(false);
    mockRecreateDomainIdentity.mockReset();
    mockDb.domainDkimKey.findUnique.mockReset();
    mockDb.domainDkimKey.findUnique.mockResolvedValue(null);
    mockRedis.incr.mockReset();
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockReset();

    mockRenderDomainVerificationStatusEmail.mockResolvedValue(
      "<p>domain status</p>",
    );
    mockRedis.set.mockResolvedValue("OK");
    mockDb.teamUser.findMany.mockResolvedValue([
      { user: { email: "alice@example.com" } },
      { user: { email: "bob@example.com" } },
    ]);
    mockResolveTxt.mockImplementation(
      (_name: string, cb: (err: Error | null, value?: string[][]) => void) => {
        cb(null, [["v=DMARC1; p=none;"]]);
      },
    );
  });

  it("sends success status emails to all team members when a new domain becomes verified", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    const result = await refreshDomainVerification(domain);

    expect(mockDb.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DomainStatus.SUCCESS,
          isVerifying: false,
          errorMessage: null,
        }),
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(wasLastNotifiedStatusStored()).toBe(true);
    expect(result.status).toBe(DomainStatus.SUCCESS);
    expect(result.hasEverVerified).toBe(true);
  });

  it("sends one failure email and stops polling on terminal failure", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.PENDING },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.PENDING },
      VerificationInfo: {
        ErrorType: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.FAILED,
    });
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.FAILED,
        dkimStatus: DomainStatus.PENDING,
        spfDetails: DomainStatus.PENDING,
        errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        isVerifying: false,
      }),
    );

    const result = await refreshDomainVerification(domain);

    expect(mockDb.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DomainStatus.FAILED,
          isVerifying: false,
          errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        }),
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(DomainStatus.FAILED);
  });

  it("does not resend status emails when the current status was already notified", async () => {
    const domain = createDomain({
      status: DomainStatus.SUCCESS,
      isVerifying: false,
    });
    mockRedis.mget.mockResolvedValue([
      new Date("2026-03-08T12:00:00.000Z").toISOString(),
      DomainStatus.SUCCESS,
      "1",
    ]);
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    await refreshDomainVerification(domain);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("does not send status email on first refresh when status is unchanged", async () => {
    const domain = createDomain({
      status: DomainStatus.SUCCESS,
      dkimStatus: DomainStatus.SUCCESS,
      spfDetails: DomainStatus.SUCCESS,
      isVerifying: false,
    });
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    await refreshDomainVerification(domain);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(wasLastNotifiedStatusStored()).toBe(false);
  });

  it("reserves the notification so concurrent refreshes do not double-send", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    let reservedOnce = false;
    mockRedis.set.mockImplementation(async (key: string) => {
      if (key.includes("notification-lock")) {
        if (reservedOnce) {
          return null;
        }

        reservedOnce = true;
        return "OK";
      }

      return "OK";
    });
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );

    await Promise.all([
      refreshDomainVerification(domain),
      refreshDomainVerification(domain),
    ]);

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockDb.domain.update).toHaveBeenCalledTimes(2);
  });

  it("logs and continues when sending the status email fails", async () => {
    const domain = createDomain();
    mockRedis.mget.mockResolvedValue([null, null, null]);
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDb.domain.update.mockResolvedValue(
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    );
    mockSendMail
      .mockRejectedValueOnce(new Error("mail failed"))
      .mockResolvedValueOnce(undefined);

    const result = await refreshDomainVerification(domain);

    expect(result.status).toBe(DomainStatus.SUCCESS);
    expect(mockDb.domain.update).toHaveBeenCalled();
    expect(wasLastNotifiedStatusStored()).toBe(false);

    expect(mockLoggerError).toHaveBeenCalledOnce();
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ message: "mail failed" }),
        domainId: domain.id,
        status: DomainStatus.SUCCESS,
      },
      "[DomainService]: Failed to send domain status notification",
    );
  });

  it("uses a 6 hour cadence for domains that have never verified", async () => {
    const domain = createDomain({ status: DomainStatus.PENDING });
    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_UNVERIFIED_RECHECK_MS + 5 * 60 * 1000,
      ).toISOString(),
      null,
      null,
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);

    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_UNVERIFIED_RECHECK_MS - 5 * 60 * 1000,
      ).toISOString(),
      null,
      null,
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(true);
  });

  it("uses a 30 day cadence after a domain has been verified", async () => {
    const domain = createDomain({ status: DomainStatus.FAILED });
    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_VERIFIED_RECHECK_MS + 5 * 60 * 1000,
      ).toISOString(),
      DomainStatus.SUCCESS,
      "1",
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);

    mockRedis.mget.mockResolvedValue([
      new Date(
        Date.now() - DOMAIN_VERIFIED_RECHECK_MS - 5 * 60 * 1000,
      ).toISOString(),
      DomainStatus.SUCCESS,
      "1",
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(true);
  });

  it("stops automatic retries after an initial terminal failure", async () => {
    const domain = createDomain({
      status: DomainStatus.FAILED,
      isVerifying: false,
    });
    mockRedis.mget.mockResolvedValue([
      new Date("2026-03-09T06:00:00.000Z").toISOString(),
      DomainStatus.FAILED,
      null,
    ]);

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);
  });

  describe("postbox mode", () => {
    function mockTxtRecords(records: Record<string, string[][]>) {
      mockResolveTxt.mockImplementation(
        (name: string, cb: (err: Error | null, value?: string[][]) => void) => {
          const value = records[name];
          if (value) {
            cb(null, value);
          } else {
            cb(
              Object.assign(new Error("queryTxt ENODATA"), { code: "ENODATA" }),
            );
          }
        },
      );
    }

    beforeEach(() => {
      mockIsPostbox.mockReturnValue(true);
      mockRedis.mget.mockResolvedValue([null, null, null]);
      mockGetDomainIdentity.mockResolvedValue({
        DkimAttributes: { Status: DomainStatus.SUCCESS },
        VerificationInfo: { ErrorType: null },
        VerificationStatus: DomainStatus.SUCCESS,
      });
      mockDb.domain.update.mockImplementation(({ data }) =>
        Promise.resolve(
          createDomain({
            name: "mail.example.com",
            subdomain: "mail",
            ...data,
          }),
        ),
      );
    });

    it("checks SPF in DNS because Postbox has no MAIL FROM status", async () => {
      mockTxtRecords({
        "mail.example.com": [
          ["v=spf1 include:spf.postbox.", "yandexcloud.net ~all"],
        ],
        "_dmarc.example.com": [["v=DMARC1; p=none;"]],
      });

      const result = await refreshDomainVerification(
        createDomain({ name: "mail.example.com", subdomain: "mail" }),
      );

      expect(mockDb.domain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            spfDetails: DomainStatus.SUCCESS,
            isVerifying: false,
          }),
        }),
      );
      expect(result.spfDetails).toBe(DomainStatus.SUCCESS);
    });

    it("keeps verifying while the Postbox SPF record is missing", async () => {
      mockTxtRecords({
        "mail.example.com": [["v=spf1 include:amazonses.com ~all"]],
      });

      const result = await refreshDomainVerification(
        createDomain({ name: "mail.example.com", subdomain: "mail" }),
      );

      expect(result.spfDetails).toBe(DomainStatus.PENDING);
      expect(mockDb.domain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isVerifying: true }),
        }),
      );
    });

    it("returns Postbox DNS records without MX and MAIL FROM", async () => {
      mockTxtRecords({});

      const result = await refreshDomainVerification(
        createDomain({ name: "mail.example.com", subdomain: "mail" }),
      );

      expect(result.dnsRecords).toEqual([
        expect.objectContaining({
          type: "TXT",
          name: "usesend._domainkey.mail",
          value: "v=DKIM1;h=sha256;k=rsa;p=public-key",
        }),
        expect.objectContaining({
          type: "TXT",
          name: "mail",
          value: "v=spf1 include:spf.postbox.yandexcloud.net ~all",
        }),
        expect.objectContaining({ type: "TXT", name: "_dmarc" }),
      ]);
    });

    describe("re-verification by recreating the identity", () => {
      const dkimName = "usesend._domainkey.mail.example.com";
      const dkimValue = "v=DKIM1;h=sha256;k=rsa;p=public-key";
      const failedIdentity = {
        DkimAttributes: { Status: DomainStatus.FAILED },
        VerificationInfo: { ErrorType: null },
        VerificationStatus: DomainStatus.FAILED,
      };
      const recreatedIdentity = {
        DkimAttributes: { Status: DomainStatus.NOT_STARTED },
        VerificationInfo: { ErrorType: null },
        VerificationStatus: DomainStatus.NOT_STARTED,
      };
      const domain = () =>
        createDomain({
          name: "mail.example.com",
          subdomain: "mail",
          status: DomainStatus.FAILED,
        });

      beforeEach(() => {
        mockDb.domainDkimKey.findUnique.mockResolvedValue({
          domainId: 42,
          encryptedPrivateKey: encryptSecret(
            "private-key",
            "domain-dkim-private-key",
          ),
        });
        mockGetDomainIdentity
          .mockReset()
          .mockResolvedValueOnce(failedIdentity)
          .mockResolvedValueOnce(recreatedIdentity);
      });

      it("recreates the identity with the stored key when the DKIM record is correct", async () => {
        mockTxtRecords({ [dkimName]: [[dkimValue]] });

        const result = await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).toHaveBeenCalledWith(
          "mail.example.com",
          "us-east-1",
          "usesend",
          "private-key",
        );
        expect(result.status).toBe(DomainStatus.NOT_STARTED);
        expect(mockDb.domain.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ isVerifying: true }),
          }),
        );
        // The recreated identity is transient: no status email.
        expect(mockSendMail).not.toHaveBeenCalled();
      });

      it("does not recreate when the DKIM record does not match", async () => {
        mockTxtRecords({
          [dkimName]: [["v=DKIM1; k=rsa; p=public-key"]],
        });

        const result = await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).not.toHaveBeenCalled();
        expect(result.status).toBe(DomainStatus.FAILED);
      });

      it("does not recreate domains without a stored key", async () => {
        mockTxtRecords({ [dkimName]: [[dkimValue]] });
        mockDb.domainDkimKey.findUnique.mockResolvedValue(null);

        await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).not.toHaveBeenCalled();
      });

      it("does not recreate again during the cooldown", async () => {
        mockTxtRecords({ [dkimName]: [[dkimValue]] });
        mockRedis.set.mockImplementation((key: string) =>
          Promise.resolve(key.includes("postbox-recreate-lock") ? null : "OK"),
        );

        await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).not.toHaveBeenCalled();
      });

      it("stops after the daily cap", async () => {
        mockTxtRecords({ [dkimName]: [[dkimValue]] });
        mockRedis.incr.mockResolvedValue(POSTBOX_RECREATE_MAX_PER_DAY + 1);

        await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).not.toHaveBeenCalled();
      });

      it("skips keys that cannot be decrypted", async () => {
        mockTxtRecords({ [dkimName]: [[dkimValue]] });
        mockDb.domainDkimKey.findUnique.mockResolvedValue({
          domainId: 42,
          encryptedPrivateKey: "v1:broken:value:here",
        });

        await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).not.toHaveBeenCalled();
        expect(mockLoggerError).toHaveBeenCalled();
      });

      it("restores an identity that a failed recreate left missing", async () => {
        mockTxtRecords({ [dkimName]: [[dkimValue]] });
        mockGetDomainIdentity
          .mockReset()
          .mockRejectedValueOnce(
            Object.assign(new Error("NotFound"), { name: "NotFoundException" }),
          )
          .mockResolvedValueOnce(recreatedIdentity);

        const result = await refreshDomainVerification(domain());

        expect(mockRecreateDomainIdentity).toHaveBeenCalledTimes(1);
        expect(result.status).toBe(DomainStatus.NOT_STARTED);
      });
    });
  });

  it("persists a new Postbox DKIM key encrypted without returning it with the domain", async () => {
    mockIsPostbox.mockReturnValue(true);
    mockAddDomain.mockResolvedValue({
      publicKey: "public-key",
      privateKey: "private-key",
    });
    mockDb.domain.create.mockResolvedValue(createDomain());
    const result = await persistDomain(7, "example.com", "ru-central1");
    const data = mockDb.domain.create.mock.calls[0]![0].data;
    const ciphertext = data.dkimKey.create.encryptedPrivateKey;
    expect(ciphertext).not.toContain("private-key");
    expect(decryptSecret(ciphertext, "domain-dkim-private-key")).toBe(
      "private-key",
    );
    expect(result).not.toHaveProperty("dkimKey");
    expect(result).not.toHaveProperty("privateKey");
  });

  describe("validateDomainFromEmail", () => {
    const ownedDomain = createDomain({
      id: 42,
      name: "b-corp.test",
      status: DomainStatus.SUCCESS,
    });

    beforeEach(() => {
      mockDb.domain.findFirst.mockImplementation(
        async ({ where }: { where: { name: string; teamId: number } }) =>
          where.name === ownedDomain.name && where.teamId === 7
            ? ownedDomain
            : null,
      );
    });

    it.each([
      "billing@b-corp.test",
      "Billing <billing@b-corp.test>",
      '"Billing, Team" <billing@b-corp.test>',
    ])("accepts %s", async (from) => {
      await expect(validateDomainFromEmail(from, 7)).resolves.toBe(ownedDomain);
    });

    it.each([
      "billing@a-corp.test",
      "Billing (<x@b-corp.test>) <billing@a-corp.test>",
      '"Me <x@b-corp.test>" <billing@a-corp.test>',
    ])("looks up the delivered domain for %s", async (from) => {
      await expect(validateDomainFromEmail(from, 7)).rejects.toThrow(
        "Domain: a-corp.test of from email is wrong",
      );
    });

    it.each([
      "billing@a-corp.test@b-corp.test",
      "x@b-corp.test@a-corp.test",
      "Group: billing@a-corp.test;",
      "Billing <x@b-corp.test>, billing@a-corp.test",
    ])("rejects %s before looking up a domain", async (from) => {
      await expect(validateDomainFromEmail(from, 7)).rejects.toThrow(
        "From email is invalid",
      );
      expect(mockDb.domain.findFirst).not.toHaveBeenCalled();
    });

    it("does not let a domain-scoped API key send from another domain", async () => {
      const apiKey = { domainId: 42 } as Parameters<
        typeof validateApiKeyDomainAccess
      >[2];

      await expect(
        validateApiKeyDomainAccess(
          "Billing (<x@b-corp.test>) <billing@a-corp.test>",
          7,
          apiKey,
        ),
      ).rejects.toThrow("Domain: a-corp.test of from email is wrong");
    });
  });
});
