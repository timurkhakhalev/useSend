import { Command } from "commander";
import {
  flatList,
  optsOf,
  parseIntOption,
  parseStringRecord,
  printDryRun,
  requireYes,
  type Context,
} from "../context";
import { usageError } from "../errors";
import { renderKv, renderTable } from "../output";

const CONTACT_COLUMNS: Array<[string, string]> = [
  ["id", "id"],
  ["email", "email"],
  ["firstName", "first"],
  ["lastName", "last"],
  ["subscribed", "subscribed"],
  ["createdAt", "created"],
];

type ContactFlags = {
  email?: string;
  firstName?: string;
  lastName?: string;
  properties?: string;
  subscribed?: boolean;
  unsubscribed?: boolean;
};

function contactBody(o: ContactFlags) {
  if (o.subscribed && o.unsubscribed)
    throw usageError("Use either --subscribed or --unsubscribed");
  const body: Record<string, unknown> = {};
  if (o.email) body.email = o.email;
  if (o.firstName !== undefined) body.firstName = o.firstName;
  if (o.lastName !== undefined) body.lastName = o.lastName;
  const props = parseStringRecord("--properties", o.properties);
  if (props) body.properties = props;
  if (o.subscribed) body.subscribed = true;
  if (o.unsubscribed) body.subscribed = false;
  return body;
}

function withContactFlags(cmd: Command, emailRequired: boolean) {
  if (emailRequired) cmd.requiredOption("--email <email>", "contact email");
  return cmd
    .option("--first-name <name>", "first name")
    .option("--last-name <name>", "last name")
    .option(
      "--properties <json>",
      "custom properties as a JSON object of strings",
    )
    .option("--subscribed", "mark subscribed")
    .option("--unsubscribed", "mark unsubscribed");
}

const bookPath = (id: string) => `/contactBooks/${encodeURIComponent(id)}`;

export function registerContacts(program: Command, ctx: Context) {
  const contacts = program
    .command("contacts")
    .description("Manage contacts inside a contact book");

  contacts
    .command("list <bookId>")
    .description("List contacts of a contact book")
    .option("--emails <list>", "only these emails (comma-separated)")
    .option("--ids <list>", "only these contact ids (comma-separated)")
    .option("--page <n>", "page number")
    .option("--limit <n>", "page size (server default 5000)")
    .action(async (bookId: string, _o, cmd: Command) => {
      const o = optsOf<{
        emails?: string;
        ids?: string;
        page?: string;
        limit?: string;
      }>(cmd);
      const list = await ctx
        .client(o)
        .get<Record<string, unknown>[]>(`${bookPath(bookId)}/contacts`, {
          query: {
            emails: flatList(o.emails)?.join(","),
            ids: flatList(o.ids)?.join(","),
            page: parseIntOption("--page", o.page),
            limit: parseIntOption("--limit", o.limit),
          },
        });
      ctx.out.result(
        list,
        (l) => `${renderTable(l, CONTACT_COLUMNS)}\n\n${l.length} contacts`,
      );
    });

  contacts
    .command("get <bookId> <contactId>")
    .description("Show one contact")
    .action(async (bookId: string, contactId: string, _o, cmd: Command) => {
      const c = await ctx
        .client(optsOf(cmd))
        .get<Record<string, unknown>>(
          `${bookPath(bookId)}/contacts/${encodeURIComponent(contactId)}`,
        );
      ctx.out.result(c, (x) => renderKv(x));
    });

  withContactFlags(
    contacts.command("add <bookId>").description("Add a contact to a book"),
    true,
  )
    .option("--dry-run", "print the request instead of sending")
    .action(async (bookId: string, _o, cmd: Command) => {
      const o = optsOf<ContactFlags & { dryRun?: boolean }>(cmd);
      const body = contactBody(o);
      const path = `${bookPath(bookId)}/contacts`;
      if (o.dryRun) return printDryRun(ctx, { method: "POST", path, body });
      const res = await ctx.client(o).post<{ contactId?: string }>(path, body);
      ctx.out.result(res, (r) => `Added contact ${r.contactId}`);
    });

  withContactFlags(
    contacts
      .command("update <bookId> <contactId>")
      .description("Update fields of a contact"),
    false,
  ).action(async (bookId: string, contactId: string, _o, cmd: Command) => {
    const o = optsOf<ContactFlags>(cmd);
    const body = contactBody(o);
    if (Object.keys(body).length === 0)
      throw usageError("Nothing to update: pass at least one field flag");
    const res = await ctx
      .client(o)
      .patch<{ contactId?: string }>(
        `${bookPath(bookId)}/contacts/${encodeURIComponent(contactId)}`,
        body,
      );
    ctx.out.result(res, () => `Updated contact ${contactId}`);
  });

  withContactFlags(
    contacts
      .command("upsert <bookId> <contactId>")
      .description("Create or update a contact by id"),
    true,
  ).action(async (bookId: string, contactId: string, _o, cmd: Command) => {
    const o = optsOf<ContactFlags>(cmd);
    const res = await ctx
      .client(o)
      .put<{ contactId: string }>(
        `${bookPath(bookId)}/contacts/${encodeURIComponent(contactId)}`,
        contactBody(o),
      );
    ctx.out.result(res, (r) => `Upserted contact ${r.contactId}`);
  });

  contacts
    .command("delete <bookId> <contactId>")
    .description("Delete a contact (requires --yes)")
    .option("-y, --yes", "confirm deletion")
    .action(async (bookId: string, contactId: string, _o, cmd: Command) => {
      const o = optsOf<{ yes?: boolean }>(cmd);
      const path = `${bookPath(bookId)}/contacts/${encodeURIComponent(contactId)}`;
      requireYes(o, `Delete contact ${contactId} from book ${bookId}`, {
        method: "DELETE",
        path,
      });
      const res = await ctx.client(o).delete<{ success: boolean }>(path);
      ctx.out.result(res, () => `Deleted contact ${contactId}`);
    });

  contacts
    .command("bulk-add <bookId>")
    .description("Add up to 1000 contacts from a JSON array file")
    .requiredOption(
      "--file <path>",
      "JSON array of {email, firstName?, lastName?, properties?, subscribed?} ('-' = stdin)",
    )
    .option("--dry-run", "print the request instead of sending")
    .action(async (bookId: string, _o, cmd: Command) => {
      const o = optsOf<{ file: string; dryRun?: boolean }>(cmd);
      const list = await ctx.readJson<unknown[]>(o.file, "contacts file");
      if (!Array.isArray(list))
        throw usageError("Contacts file must be a JSON array");
      if (list.length === 0 || list.length > 1000)
        throw usageError(
          `Contacts file must have 1..1000 entries (got ${list.length})`,
        );
      list.forEach((c, i) => {
        if (!c || typeof (c as { email?: unknown }).email !== "string")
          throw usageError(`Entry ${i} has no "email"`);
      });
      const path = `${bookPath(bookId)}/contacts/bulk`;
      if (o.dryRun)
        return printDryRun(ctx, { method: "POST", path, body: list });
      const res = await ctx
        .client(o)
        .post<{ message: string; count: number }>(path, list);
      ctx.out.result(res, (r) => `${r.message} (${r.count})`);
    });

  contacts
    .command("bulk-delete <bookId>")
    .description("Delete up to 1000 contacts by id (requires --yes)")
    .requiredOption("--ids <list>", "contact ids, comma-separated")
    .option("-y, --yes", "confirm deletion")
    .action(async (bookId: string, _o, cmd: Command) => {
      const o = optsOf<{ ids: string; yes?: boolean }>(cmd);
      const contactIds = flatList(o.ids) ?? [];
      if (contactIds.length === 0 || contactIds.length > 1000)
        throw usageError("--ids needs 1..1000 ids");
      const path = `${bookPath(bookId)}/contacts/bulk`;
      requireYes(
        o,
        `Delete ${contactIds.length} contacts from book ${bookId}`,
        {
          method: "DELETE",
          path,
          contactIds,
        },
      );
      const res = await ctx
        .client(o)
        .delete<{ success: boolean; count: number }>(path, { contactIds });
      ctx.out.result(res, (r) => `Deleted ${r.count} contacts`);
    });
}

type BookFlags = {
  name?: string;
  emoji?: string;
  properties?: string;
  variables?: string;
  doubleOptIn?: boolean;
  noDoubleOptIn?: boolean;
  doubleOptInFrom?: string;
  doubleOptInSubject?: string;
  doubleOptInContent?: string;
};

function bookBody(o: BookFlags & { doubleOptIn?: boolean | undefined }) {
  const body: Record<string, unknown> = {};
  if (o.name) body.name = o.name;
  if (o.emoji) body.emoji = o.emoji;
  const props = parseStringRecord("--properties", o.properties);
  if (props) body.properties = props;
  const vars = flatList(o.variables);
  if (vars) body.variables = vars;
  if (o.doubleOptIn !== undefined) body.doubleOptInEnabled = o.doubleOptIn;
  if (o.doubleOptInFrom) body.doubleOptInFrom = o.doubleOptInFrom;
  if (o.doubleOptInSubject) body.doubleOptInSubject = o.doubleOptInSubject;
  if (o.doubleOptInContent) body.doubleOptInContent = o.doubleOptInContent;
  return body;
}

function withBookFlags(cmd: Command) {
  return cmd
    .option("--emoji <emoji>", "emoji shown in the dashboard")
    .option("--properties <json>", "custom properties JSON object")
    .option(
      "--variables <list>",
      "allowed personalization variables, comma-separated",
    )
    .option("--double-opt-in", "enable double opt-in")
    .option("--no-double-opt-in", "disable double opt-in")
    .option(
      "--double-opt-in-from <address>",
      "sender of the confirmation email",
    )
    .option(
      "--double-opt-in-subject <text>",
      "subject of the confirmation email",
    )
    .option(
      "--double-opt-in-content <text>",
      "content of the confirmation email",
    );
}

export function registerContactBooks(program: Command, ctx: Context) {
  const books = program
    .command("contact-books")
    .description("Manage contact books (audiences for campaigns)");

  books
    .command("list")
    .description("List contact books")
    .action(async (_o, cmd: Command) => {
      const list = await ctx
        .client(optsOf(cmd))
        .get<Record<string, unknown>[]>("/contactBooks");
      ctx.out.result(list, (l) =>
        renderTable(
          l.map((b) => ({
            ...b,
            contacts: (b._count as { contacts?: number } | undefined)?.contacts,
          })),
          [
            ["id", "id"],
            ["emoji", ""],
            ["name", "name"],
            ["contacts", "contacts"],
            ["createdAt", "created"],
          ],
        ),
      );
    });

  books
    .command("get <bookId>")
    .description("Show a contact book")
    .action(async (bookId: string, _o, cmd: Command) => {
      const b = await ctx
        .client(optsOf(cmd))
        .get<Record<string, unknown>>(bookPath(bookId));
      ctx.out.result(b, (x) => renderKv(x));
    });

  withBookFlags(
    books.command("create <name>").description("Create a contact book"),
  )
    .option("--dry-run", "print the request instead of sending")
    .action(async (name: string, _o, cmd: Command) => {
      const o = optsOf<BookFlags & { dryRun?: boolean }>(cmd);
      const body = {
        ...bookBody({ ...o, doubleOptIn: explicitDoubleOptIn(cmd) }),
        name,
      };
      if (o.dryRun)
        return printDryRun(ctx, {
          method: "POST",
          path: "/contactBooks",
          body,
        });
      const res = await ctx
        .client(o)
        .post<Record<string, unknown>>("/contactBooks", body);
      ctx.out.result(res, (r) => `Created contact book ${r.id} (${r.name})`);
    });

  withBookFlags(
    books.command("update <bookId>").description("Update a contact book"),
  )
    .option("--name <name>", "new name")
    .action(async (bookId: string, _o, cmd: Command) => {
      const o = optsOf<BookFlags>(cmd);
      const body = bookBody({ ...o, doubleOptIn: explicitDoubleOptIn(cmd) });
      if (Object.keys(body).length === 0)
        throw usageError("Nothing to update: pass at least one flag");
      const res = await ctx
        .client(o)
        .patch<Record<string, unknown>>(bookPath(bookId), body);
      ctx.out.result(res, () => `Updated contact book ${bookId}`);
    });

  books
    .command("delete <bookId>")
    .description("Delete a contact book and its contacts (requires --yes)")
    .option("-y, --yes", "confirm deletion")
    .action(async (bookId: string, _o, cmd: Command) => {
      const o = optsOf<{ yes?: boolean }>(cmd);
      requireYes(
        o,
        `Delete contact book ${bookId} including all of its contacts`,
        {
          method: "DELETE",
          path: bookPath(bookId),
        },
      );
      const res = await ctx
        .client(o)
        .delete<{ id: string; message: string }>(bookPath(bookId));
      ctx.out.result(res, (r) => `${r.message} (${r.id})`);
    });
}

/** commander sets doubleOptIn=true by default for --no-*; only send it if the user passed a flag. */
function explicitDoubleOptIn(cmd: Command): boolean | undefined {
  const src = cmd.getOptionValueSource("doubleOptIn");
  return src === "cli" ? (cmd.opts().doubleOptIn as boolean) : undefined;
}
