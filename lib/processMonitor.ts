import { log } from "./server/httpWsServer.ts";

type Listener = (output: string) => void;

export interface ProcessConfig {
  bin: string;
  args?: string[];
  cwd?: string;

  customTerminate?: string;
}

export class ProcessMonitor {
  private listeners = new Set<Listener>();
  private encoder = new TextEncoder();
  private stdin;
  history = "";
  process;
  customTerminate;

  constructor(config: ProcessConfig) {
    this.customTerminate = config.customTerminate;

    const args = [config.bin, config.args?.join(" ")];

    this.process = new Deno.Command("script", {
      args: ["-qec", args.join(" ")].filter(Boolean),
      cwd: config.cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: {
        TERM: "xterm-256color",
        LANG: "C.utf8",
      },
    }).spawn();

    log(
      "ProcessMonitor",
      `Starting process ${this.process.pid}: "script -qec ${args?.join(" ")}"`,
    );

    const createHandler = () =>
      new WritableStream({
        write: (chunk: string) => this.handleNewOutput(chunk),
      });

    this.process.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeTo(createHandler());
    this.process.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeTo(createHandler());

    this.stdin = this.process.stdin.getWriter();

    this.process.status.then(() => {
      this.handleNewOutput("*** process stopped ***");
    });
  }

  private handleNewOutput(chunk: string) {
    chunk = chunk.replaceAll("\r\n", "\n");
    this.history += chunk;

    for (const listener of this.listeners.values()) {
      listener(chunk);
    }
  }

  private killSignal(signal: Deno.Signal | number) {
    const result = new Deno.Command("pgrep", {
      args: ["-P", this.process.pid.toString()],
    }).outputSync();

    const stdout = new TextDecoder().decode(result.stdout);
    const processes = stdout.split("\n").map((n) => Number(n));

    Deno.kill(processes[0], signal);
  }

  addListener(listener: Listener) {
    this.listeners.add(listener);
    return listener;
  }

  removeListener(listener: Listener) {
    this.listeners.delete(listener);
  }

  write(text: string) {
    this.stdin.write(this.encoder.encode(text));
  }

  terminate() {
    this.handleNewOutput("*** stop requested ***");

    if (this.customTerminate) {
      this.write(this.customTerminate);
    } else {
      this.killSignal("SIGINT");
    }
  }

  kill() {
    this.handleNewOutput("*** kill requested ***");
    this.killSignal("SIGKILL");
  }
}
