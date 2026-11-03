import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "../src/errors";
import { Output, renderTable } from "../src/output";

function capture(json: boolean) {
  const buf = { out: "", err: "" };
  const o = new Output(
    json,
    (s) => (buf.out += s),
    (s) => (buf.err += s),
  );
  return { o, buf };
}

describe("Output", () => {
  it("prints {ok:true,data} in JSON mode", () => {
    const { o, buf } = capture(true);
    o.result({ id: 1 }, () => "human");
    expect(JSON.parse(buf.out)).toEqual({ ok: true, data: { id: 1 } });
  });

  it("uses the human renderer by default", () => {
    const { o, buf } = capture(false);
    o.result({ id: 1 }, (d) => `id is ${d.id}`);
    expect(buf.out).toBe("id is 1\n");
  });

  it("prints {ok:false,error} with hint and returns the exit code", () => {
    const { o, buf } = capture(true);
    const code = o.error(
      new CliError(
        "NOT_FOUND",
        "Domain not found",
        ExitCode.NOT_FOUND,
        "list first",
      ),
    );
    expect(code).toBe(4);
    expect(JSON.parse(buf.out)).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Domain not found",
        hint: "list first",
      },
    });
  });

  it("writes human errors to stderr, not stdout", () => {
    const { o, buf } = capture(false);
    o.error(new Error("boom"));
    expect(buf.out).toBe("");
    expect(buf.err).toContain("error [UNEXPECTED]: boom");
  });

  it("suppresses notes in JSON mode", () => {
    const { o, buf } = capture(true);
    o.note("progress");
    expect(buf.err).toBe("");
  });

  it("renders aligned tables", () => {
    const t = renderTable(
      [
        { id: 1, name: "a" },
        { id: 22, name: "bbb" },
      ],
      [
        ["id", "id"],
        ["name", "name"],
      ],
    );
    expect(t.split("\n")).toEqual(["ID  NAME", "1   a", "22  bbb"]);
  });
});
