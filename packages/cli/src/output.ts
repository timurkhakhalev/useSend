import { CliError, ExitCode } from "./errors";

export type Writer = (chunk: string) => void;

export type JsonSuccess<T> = { ok: true; data: T };
export type JsonFailure = {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: unknown };
};

export class Output {
  constructor(
    public readonly json: boolean,
    private readonly stdout: Writer = (s) => void process.stdout.write(s),
    private readonly stderr: Writer = (s) => void process.stderr.write(s),
  ) {}

  /** Print a successful result. `human` renders the default text form. */
  result<T>(data: T, human?: (data: T) => string | undefined) {
    if (this.json) {
      this.stdout(
        JSON.stringify({ ok: true, data } satisfies JsonSuccess<T>, null, 2) +
          "\n",
      );
      return;
    }
    const text = human ? human(data) : renderValue(data);
    if (text !== undefined && text !== "")
      this.stdout(text.endsWith("\n") ? text : text + "\n");
  }

  /** Progress/notes for humans. Goes to stderr; suppressed in --json mode. */
  note(message: string) {
    if (!this.json) this.stderr(message + "\n");
  }

  error(err: unknown): number {
    const e = toCliError(err);
    if (this.json) {
      const payload: JsonFailure = {
        ok: false,
        error: { code: e.code, message: e.message },
      };
      if (e.hint) payload.error.hint = e.hint;
      if (e.details !== undefined) payload.error.details = e.details;
      this.stdout(JSON.stringify(payload, null, 2) + "\n");
    } else {
      let msg = `error [${e.code}]: ${e.message}\n`;
      if (e.details !== undefined && e.code === "CONFIRMATION_REQUIRED") {
        msg += `\nWould run:\n${indent(renderValue(e.details))}\n\n`;
      }
      if (e.hint) msg += `hint: ${e.hint}\n`;
      this.stderr(msg);
    }
    return e.exitCode;
  }
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CliError("UNEXPECTED", message, ExitCode.GENERAL);
}

function indent(s: string, pad = "  ") {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (Array.isArray(v)) return v.map(scalar).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Generic human rendering for values without a dedicated renderer. */
export function renderValue(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "(none)";
    if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const cols = Array.from(
        new Set(v.flatMap((x) => Object.keys(x as object))),
      ).filter((k) => {
        // Skip bulky columns in generic tables.
        return ![
          "html",
          "content",
          "text",
          "properties",
          "publicKey",
          "dnsRecords",
        ].includes(k);
      });
      return renderTable(
        v as Record<string, unknown>[],
        cols.map((c) => [c, c]),
      );
    }
    return v.map(scalar).join("\n");
  }
  if (v && typeof v === "object") return renderKv(v as Record<string, unknown>);
  return scalar(v);
}

export function renderKv(
  obj: Record<string, unknown>,
  keys?: string[],
): string {
  const entries = (keys ?? Object.keys(obj))
    .filter((k) => k in obj)
    .map((k) => [k, obj[k]] as const);
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${k.padEnd(width)}  ${scalar(v)}`).join("\n");
}

export function renderTable(
  rows: Record<string, unknown>[],
  columns: Array<[key: string, label: string]>,
  maxWidth = 48,
): string {
  if (rows.length === 0) return "(none)";
  const cell = (v: unknown) => {
    const s = scalar(v).replace(/\s+/g, " ");
    return s.length > maxWidth ? s.slice(0, maxWidth - 1) + "…" : s;
  };
  const data = rows.map((r) => columns.map(([k]) => cell(r[k])));
  const widths = columns.map(([, label], i) =>
    Math.max(label.length, ...data.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ");
  return [
    line(columns.map(([, l]) => l.toUpperCase())),
    ...data.map(line),
  ].join("\n");
}
