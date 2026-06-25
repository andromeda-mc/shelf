type Listener = (output: string) => void;

export class ConsoleWatcher {
  private listeners = new Set<Listener>();
  private encoder = new TextEncoder();
  private stdin;
  history = "";
  process;

  constructor(bin: string, args?: string[], cwd?: string) {
    this.process = new Deno.Command(bin, {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

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
      this.write("*** process stopped ***");
    });
  }

  private handleNewOutput(chunk: string) {
    this.history += chunk;

    for (const listener of this.listeners.values()) {
      listener(chunk);
    }
  }

  addListener(listener: Listener) {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener) {
    this.listeners.delete(listener);
  }

  write(text: string) {
    this.stdin.write(this.encoder.encode(text));
  }

  terminate() {
    this.process.kill("SIGINT");
  }

  kill() {
    this.write("*** kill requested ***");
    this.process.kill("SIGKILL");
  }
}
