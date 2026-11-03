import { describe, expect, it } from "vitest";
import { emailSchema } from "./email-schema";

const payload = {
  to: "user@example.com",
  from: "hello@example.com",
  subject: "Inline",
  html: '<img src="cid:torch@site">',
};
const attachment = {
  filename: "torch.png",
  content: "aW1hZ2U=",
  contentId: "torch@site",
  contentType: "image/png",
};

describe("email attachment schema", () => {
  it("keeps inline metadata in single and batch requests", () => {
    expect(
      emailSchema.parse({ ...payload, attachments: [attachment] }).attachments,
    ).toEqual([attachment]);
    expect(
      emailSchema.array().parse([{ ...payload, attachments: [attachment] }])[0]
        ?.attachments,
    ).toEqual([attachment]);
  });

  it.each(["", "<torch@site>", "torch @site", "torch\r\nX-Header: injected"])(
    "rejects invalid content IDs: %j",
    (contentId) => {
      expect(
        emailSchema.safeParse({
          ...payload,
          attachments: [{ ...attachment, contentId }],
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a content type containing header injection", () => {
    expect(
      emailSchema.safeParse({
        ...payload,
        attachments: [
          { ...attachment, contentType: "image/png\r\nX-Header: injected" },
        ],
      }).success,
    ).toBe(false);
  });
});
