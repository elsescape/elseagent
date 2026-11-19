import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSize } from "../util/text.ts";
import {
  attachmentsDir,
  describeFiles,
  MAX_REPLY_FILES,
  resolveReplyFiles,
  safeFileName,
  saveAttachments,
} from "./files.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "elseagent-files-"));

test("safeFileName keeps names inside the folder", () => {
  expect(safeFileName("report.pdf")).toBe("report.pdf");
  expect(safeFileName("../../etc/passwd")).toBe("passwd");
  expect(safeFileName("a\\b\\c.txt")).toBe("c.txt");
  expect(safeFileName(".bashrc")).toBe("bashrc");
  expect(safeFileName("..")).toBe("file");
  expect(safeFileName("a\nb:c.txt")).toBe("a_b_c.txt");
  const long = safeFileName(`${"x".repeat(300)}.png`);
  expect(long).toHaveLength(120);
  expect(long.endsWith(".png")).toBe(true);
});

test("attachmentsDir: one folder per conversation", () => {
  expect(attachmentsDir("/w", "C1:1712.34")).toBe("/w/attachments/C1-1712.34");
  expect(attachmentsDir("/w", "tg:42:7")).toBe("/w/attachments/tg-42-7");
});

test("formatSize", () => {
  expect(formatSize(12)).toBe("12 B");
  expect(formatSize(2048)).toBe("2 KB");
  expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
});

describe("saveAttachments", () => {
  test("downloads each file; failures are recorded and leave nothing behind", async () => {
    const dir = join(tmp(), "a");
    const saved = await saveAttachments(
      [
        { name: "ok.txt", ref: "1" },
        { name: "bad.txt", ref: "2" },
      ],
      dir,
      async (file, dest) => {
        await Bun.write(dest, "partial");
        if (file.ref === "2") throw new Error("HTTP 403");
      },
    );
    expect(saved).toEqual([
      { name: "ok.txt", mimetype: undefined, size: 7, path: join(dir, "ok.txt") },
      { name: "bad.txt", mimetype: undefined, size: undefined, error: "HTTP 403" },
    ]);
    expect(await Bun.file(join(dir, "bad.txt")).exists()).toBe(false);
    expect(describeFiles(saved, dir.replace(/\/a$/, ""))).toEqual([
      "[attached file: a/ok.txt (7 B)]",
      "[attached file bad.txt: could not be downloaded (HTTP 403)]",
    ]);
  });
});

describe("resolveReplyFiles", () => {
  test("relative to the workspace or absolute; problems reported", async () => {
    const w = tmp();
    await Bun.write(join(w, "out/chart.png"), "png");
    await Bun.write(join(w, "empty.txt"), "");
    const abs = join(tmp(), "abs.csv");
    await Bun.write(abs, "a,b");
    const { files, problems } = await resolveReplyFiles(
      ["out/chart.png", abs, "out/chart.png", "nope.txt", "out", "empty.txt", " "],
      w,
    );
    expect(files).toEqual([
      { path: join(w, "out/chart.png"), name: "chart.png" },
      { path: abs, name: "abs.csv" },
    ]);
    expect(problems).toEqual(["`nope.txt`: not found", "`out`: not a file", "`empty.txt`: empty"]);
  });

  test("at most MAX_REPLY_FILES", async () => {
    const w = tmp();
    const names = Array.from({ length: MAX_REPLY_FILES + 1 }, (_, i) => `f${i}.txt`);
    for (const n of names) await Bun.write(join(w, n), "x");
    const { files, problems } = await resolveReplyFiles(names, w);
    expect(files).toHaveLength(MAX_REPLY_FILES);
    expect(problems).toHaveLength(1);
  });
});

test("saveAttachments leaves a file that is already in place where it is", async () => {
  const dir = tmp();
  const here = join(dir, "here.png");
  await Bun.write(here, "PNG");
  const gone = join(dir, "gone.png");
  const saved = await saveAttachments(
    [
      { name: "here.png", mimetype: "image/png", size: 3, ref: here, path: here },
      { name: "gone.png", ref: gone, path: gone },
    ],
    join(dir, "attachments"),
    async () => {
      throw new Error("nothing to download");
    },
  );
  expect(saved).toEqual([
    { name: "here.png", mimetype: "image/png", size: 3, path: here },
    { name: "gone.png", mimetype: undefined, size: undefined, error: "no longer there" },
  ]);
});
