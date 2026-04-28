import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getQueuedFileWriter, resolveQueuedFileAppendFlags } from "./queued-file-writer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-queued-writer-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("getQueuedFileWriter", () => {
  it("keeps append flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveQueuedFileAppendFlags({
        O_APPEND: 0x01,
        O_CREAT: 0x02,
        O_RDWR: 0x04,
      }),
    ).toBe(0x07);
  });

  it("deduplicates replayed appends by idempotency key", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write('{"idempotencyKey":"event-1","message":"first"}\n', {
      idempotencyKey: "event-1",
    });
    writer.write('{"idempotencyKey":"event-1","message":"duplicate"}\n', {
      idempotencyKey: "event-1",
    });
    writer.write('{"idempotencyKey":"event-2","message":"second"}\n', {
      idempotencyKey: "event-2",
    });
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe(
      '{"idempotencyKey":"event-1","message":"first"}\n' +
        '{"idempotencyKey":"event-2","message":"second"}\n',
    );
  });

  it("deduplicates already-persisted appends after writer restart", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    fs.writeFileSync(filePath, '{"idempotencyKey":"event-1","message":"persisted"}\n', {
      mode: 0o600,
    });
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write('{"idempotencyKey":"event-1","message":"replayed"}\n', {
      idempotencyKey: "event-1",
    });
    writer.write('{"idempotencyKey":"event-2","message":"new"}\n', {
      idempotencyKey: "event-2",
    });
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe(
      '{"idempotencyKey":"event-1","message":"persisted"}\n' +
        '{"idempotencyKey":"event-2","message":"new"}\n',
    );
  });

  it("creates log files with restrictive permissions", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("line\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("line\n");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("refuses to append through a symlink", async () => {
    const tmpDir = makeTempDir();
    const targetPath = path.join(tmpDir, "target.txt");
    const filePath = path.join(tmpDir, "trace.jsonl");
    fs.writeFileSync(targetPath, "before\n", "utf8");
    fs.symlinkSync(targetPath, filePath);
    const writer = getQueuedFileWriter(new Map(), filePath);

    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(targetPath, "utf8")).toBe("before\n");
  });

  it("refuses to append through a symlinked parent directory", async () => {
    const tmpDir = makeTempDir();
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const writer = getQueuedFileWriter(new Map(), path.join(linkDir, "trace.jsonl"));

    writer.write("after\n");
    await writer.flush();

    expect(fs.existsSync(path.join(targetDir, "trace.jsonl"))).toBe(false);
  });

  it("stops appending when the configured file cap is reached", async () => {
    const tmpDir = makeTempDir();
    const filePath = path.join(tmpDir, "trace.jsonl");
    const writer = getQueuedFileWriter(new Map(), filePath, { maxFileBytes: 6 });

    writer.write("12345\n");
    writer.write("after\n");
    await writer.flush();

    expect(fs.readFileSync(filePath, "utf8")).toBe("12345\n");
  });
});
