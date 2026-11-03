import { describe, expect, it } from "vitest";
import { ENV, cli, mockFetch } from "./helpers";

describe("public API command contracts", () => {
  it("keeps contact-book fields separate from contact updates", async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: { id: "book1", contactId: "contact1" },
    }));
    const book = await cli(
      [
        "contact-books",
        "update",
        "book1",
        "--name",
        "Customers",
        "--no-double-opt-in",
        "--variables",
        "name,company",
        "--json",
      ],
      { env: ENV, fetch },
    );
    expect(book.code).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: {
        name: "Customers",
        doubleOptInEnabled: false,
        variables: ["name", "company"],
      },
    });
    const contact = await cli(
      ["contacts", "update", "book1", "contact1", "--unsubscribed", "--json"],
      { env: ENV, fetch },
    );
    expect(contact.code).toBe(0);
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      body: { subscribed: false },
    });
    const unsupported = await cli(
      [
        "contacts",
        "update",
        "book1",
        "contact1",
        "--email",
        "new@example.com",
        "--json",
      ],
      { env: ENV, fetch },
    );
    expect(unsupported.code).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("creates drafts without scheduling or enabling double opt-in implicitly", async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: { id: "draft1", status: "DRAFT" },
    }));
    const campaign = await cli(
      [
        "campaigns",
        "create",
        "--name",
        "Launch",
        "--from",
        "from@example.com",
        "--subject",
        "Hi",
        "--contact-book",
        "book1",
        "--html",
        "<p>Hello</p>",
        "--json",
      ],
      { env: ENV, fetch },
    );
    expect(campaign.code).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        name: "Launch",
        from: "from@example.com",
        subject: "Hi",
        contactBookId: "book1",
        html: "<p>Hello</p>",
      },
    });
    expect(calls[0]!.body).not.toHaveProperty("sendNow");
    const book = await cli(["contact-books", "create", "Audience", "--json"], {
      env: ENV,
      fetch,
    });
    expect(book.code).toBe(0);
    expect(calls[1]!.body).toEqual({ name: "Audience" });
  });

  it("doctor fails if the health endpoint reports a server failure", async () => {
    const { fetch } = mockFetch(() => ({
      status: 503,
      body: { error: "unhealthy" },
    }));
    const result = await cli(["doctor", "--json"], { env: ENV, fetch });
    expect(result.code).toBe(1);
    expect(result.json().error.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "reachability", status: "fail" }),
      ]),
    );
  });
});
