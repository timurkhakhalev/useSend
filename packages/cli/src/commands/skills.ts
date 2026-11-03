import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, type Help } from "commander";
import { optsOf, type Context } from "../context";
import { CliError, ExitCode } from "../errors";

export type SkillMeta = { name: string; description: string; file: string };

const FULL_MARKER = "<!-- full -->";

/** Locate the bundled skills/ directory (dist/ and src/ layouts). */
export function skillsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.USESEND_SKILLS_DIR) return env.USESEND_SKILLS_DIR;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "skills");
    if (fs.existsSync(path.join(candidate, "core.md"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new CliError(
    "SKILLS_MISSING",
    "Bundled skills directory not found",
    ExitCode.GENERAL,
    "Reinstall usesend-cli.",
  );
}

export function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

export function listSkills(dir: string): SkillMeta[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { meta } = parseFrontmatter(
        fs.readFileSync(path.join(dir, f), "utf8"),
      );
      return {
        name: meta.name ?? f.replace(/\.md$/, ""),
        description: meta.description ?? "",
        file: f,
      };
    })
    .sort((a, b) =>
      a.name === "core"
        ? -1
        : b.name === "core"
          ? 1
          : a.name.localeCompare(b.name),
    );
}

export function getSkill(
  dir: string,
  name: string,
  full: boolean,
  reference?: () => string,
): string {
  const skill = listSkills(dir).find((s) => s.name === name);
  if (!skill) {
    throw new CliError(
      "NOT_FOUND",
      `Unknown skill "${name}"`,
      ExitCode.NOT_FOUND,
      `Available: ${listSkills(dir)
        .map((s) => s.name)
        .join(", ")}`,
    );
  }
  let text = fs.readFileSync(path.join(dir, skill.file), "utf8");
  const idx = text.indexOf(FULL_MARKER);
  if (full) {
    text = text.replace(FULL_MARKER, "");
    if (name === "core" && reference)
      text = `${text.trimEnd()}\n\n${reference()}`;
  } else if (idx >= 0) {
    text = `${text.slice(0, idx).trimEnd()}\n\n_More: \`usesend skills get ${name} --full\`._\n`;
  } else if (name === "core") {
    text = `${text.trimEnd()}\n\n_Full command reference: \`usesend skills get core --full\`._\n`;
  }
  return text.endsWith("\n") ? text : text + "\n";
}

/** Generated from the live command tree, so it always matches this version. */
export function commandReference(program: Command): string {
  const lines = ["## Command reference (generated)", ""];
  const help: Help = program.createHelp();
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      if ((sub as unknown as { _hidden?: boolean })._hidden) continue;
      const name = `${prefix} ${sub.name()}`.trim();
      if (sub.commands.length) {
        walk(sub, name);
        continue;
      }
      lines.push(`### ${name}`, "");
      lines.push(`\`${help.commandUsage(sub)}\` — ${sub.description()}`);
      const opts = sub.options.filter((op) => !op.hidden);
      if (opts.length) {
        lines.push("");
        for (const op of opts)
          lines.push(
            `- \`${op.flags}\` — ${op.description}${op.defaultValue !== undefined && typeof op.defaultValue !== "boolean" ? ` (default: ${op.defaultValue})` : ""}`,
          );
      }
      lines.push("");
    }
  };
  walk(program, "");
  lines.push("### Global options", "");
  for (const op of program.options)
    lines.push(`- \`${op.flags}\` — ${op.description}`);
  return lines.join("\n") + "\n";
}

export function registerSkills(program: Command, ctx: Context) {
  const skills = program
    .command("skills")
    .description("Agent skill content bundled with this CLI version");

  skills
    .command("list")
    .description("List available skills")
    .action(() => {
      const list = listSkills(skillsDir(ctx.env)).map(
        ({ name, description }) => ({ name, description }),
      );
      ctx.out.result(list, (l) => {
        const w = Math.max(...l.map((s) => s.name.length));
        return l
          .map((s) => {
            const d =
              s.description.length > 72
                ? s.description.slice(0, 69) + "..."
                : s.description;
            return `  ${s.name.padEnd(w)}  ${d}`;
          })
          .join("\n");
      });
    });

  skills
    .command("get <name>")
    .description("Print a skill as markdown (start with `core`)")
    .option(
      "--full",
      "include the full reference (core: generated command reference)",
    )
    .action((name: string, _o, cmd: Command) => {
      const o = optsOf<{ full?: boolean }>(cmd);
      const content = getSkill(skillsDir(ctx.env), name, !!o.full, () =>
        commandReference(program),
      );
      if (ctx.out.json) ctx.out.result({ name, content });
      else ctx.deps.stdout(content);
    });

  skills
    .command("install")
    .description(
      "Install the discovery stub SKILL.md for Claude Code (or another skills dir)",
    )
    .option(
      "--dir <path>",
      "skills root",
      path.join(os.homedir(), ".claude", "skills"),
    )
    .option(
      "--link",
      "symlink instead of copy (stays in sync with this install)",
    )
    .action((_o, cmd: Command) => {
      const o = optsOf<{ dir: string; link?: boolean }>(cmd);
      const src = path.join(
        path.dirname(skillsDir(ctx.env)),
        "skill",
        "SKILL.md",
      );
      const destDir = path.join(o.dir, "usesend");
      const dest = path.join(destDir, "SKILL.md");
      fs.mkdirSync(destDir, { recursive: true });
      fs.rmSync(dest, { force: true });
      if (o.link) fs.symlinkSync(src, dest);
      else fs.copyFileSync(src, dest);
      ctx.out.result(
        { installed: dest, source: src, mode: o.link ? "symlink" : "copy" },
        (d) => `Installed ${d.installed} (${d.mode} of ${d.source})`,
      );
    });
}
