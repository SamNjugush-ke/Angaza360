// ===========================================================================
// Capture EVERYTHING the process writes to stdout / stderr while a block runs
// (Task T-A3 onward), so a test can prove a secret never reached a log line.
//
// Fastify's logger (pino) does not go through process.stdout.write: it writes
// synchronously to file descriptor 1 through sonic-boom, which calls the CommonJS
// `fs.writeSync`. So all three paths are captured — fs.writeSync/fs.write on fds 1
// and 2, process.stdout/stderr.write, and console.*. Pino's fd writes are still
// passed through; stream and console output during the block is captured only.
// ===========================================================================

import fs from "node:fs";
import { vi } from "vitest";

function asText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

export async function captureOutput<T>(block: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const writeSync = fs.writeSync.bind(fs);
  const write = fs.write.bind(fs);

  const spies = [
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: string | NodeJS.ArrayBufferView, ...rest: never[]) => {
      if (fd === 1 || fd === 2) chunks.push(asText(buffer));
      return (writeSync as (fd: number, buffer: string | NodeJS.ArrayBufferView, ...rest: never[]) => number)(fd, buffer, ...rest);
    }) as typeof fs.writeSync),
    vi.spyOn(fs, "write").mockImplementation(((fd: number, buffer: string | NodeJS.ArrayBufferView, ...rest: never[]) => {
      if (fd === 1 || fd === 2) chunks.push(asText(buffer));
      (write as (fd: number, buffer: string | NodeJS.ArrayBufferView, ...rest: never[]) => void)(fd, buffer, ...rest);
    }) as typeof fs.write),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(asText(chunk));
      return true;
    }),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      chunks.push(asText(chunk));
      return true;
    }),
    ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        chunks.push(args.map(asText).join(" "));
      }),
    ),
  ];
  try {
    const result = await block();
    return { result, output: chunks.join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
