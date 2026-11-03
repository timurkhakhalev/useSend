import readline from "node:readline";
import { run } from "./cli";

/** Read a secret from the TTY without echoing it. */
function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    const out = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WritableStream;
    };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        out.output.write(s);
        prompted = true;
      }
    };
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("Cancelled"));
    });
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  stdin: process.stdin,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  promptSecret,
});
process.exitCode = code;
