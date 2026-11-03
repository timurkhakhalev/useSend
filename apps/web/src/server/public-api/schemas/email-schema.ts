import { z } from "@hono/zod-openapi";

/**
 * Reusable Zod schema for a single email payload used in public API requests.
 */
export const emailSchema = z
  .object({
    to: z.string().or(z.array(z.string())),
    from: z.string(),
    subject: z.string().min(1).optional().openapi({
      description: "Optional when templateId is provided",
    }),
    templateId: z.string().optional().openapi({
      description: "ID of a template from the dashboard",
    }),
    variables: z.record(z.string()).optional(),
    replyTo: z.string().or(z.array(z.string())).optional(),
    cc: z.string().or(z.array(z.string())).optional(),
    bcc: z.string().or(z.array(z.string())).optional(),
    text: z.string().min(1).optional().nullable(),
    html: z.coerce.string().min(1).optional().nullable(),
    headers: z.record(z.string().min(1)).optional().openapi({
      description: "Custom headers to included with the emails",
    }),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1),
          content: z.string().min(1), // Base64-encoded file data.
          contentId: z
            .string()
            .regex(/^[^\s<>]+$/)
            .optional()
            .openapi({
              description:
                "Content-ID without angle brackets; reference it as cid:<contentId> in HTML",
              example: "torch-light@giftsofprometheus",
            }),
          contentType: z
            .string()
            .regex(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+\/[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/)
            .optional()
            .openapi({
              description: "MIME type; inferred from filename when omitted",
              example: "image/png",
            }),
        }),
      )
      .max(10) // Limit attachments array size if desired
      .optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(), // Ensure ISO 8601 format with offset
    inReplyToId: z.string().optional().nullable(),
  })
  .refine(
    (data) => !!data.subject || !!data.templateId,
    "Either subject or templateId must be provided.",
  )
  .refine(
    (data) => !!data.text || !!data.html,
    "Either text or html content must be provided.",
  );
