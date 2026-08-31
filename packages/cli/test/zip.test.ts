import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { archiveOf, buildZip, collectEntries, sortEntries } from "../src/zip.js";

const entry = (path: string, body: string) => ({ path, data: Buffer.from(body) });

describe("deterministic zip", () => {
  it("produces identical bytes for identical content", async () => {
    const entries = [entry("index.js", "console.log(1)"), entry("assets/a.png", "png")];
    const [first, second] = await Promise.all([buildZip(entries), buildZip(entries)]);
    expect(first.equals(second)).toBe(true);
  });

  it("ignores the order entries are handed in", async () => {
    const a = entry("a.js", "a");
    const b = entry("b/c.js", "c");
    const sorted = await buildZip([a, b]);
    const shuffled = await buildZip([b, a]);
    expect(sorted.equals(shuffled)).toBe(true);
  });

  it("changes the hash when content changes", async () => {
    const one = await archiveOf([entry("index.js", "one")]);
    const two = await archiveOf([entry("index.js", "two")]);
    expect(one.sha256).not.toBe(two.sha256);
    expect(one.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("embeds no wall-clock timestamp", async () => {
    const first = await buildZip([entry("index.js", "x")]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await buildZip([entry("index.js", "x")]);
    expect(first.equals(second)).toBe(true);
  });

  it("sorts by bytes, not locale", () => {
    const paths = sortEntries([entry("b.js", ""), entry("A.js", ""), entry("a.js", "")]).map((e) => e.path);
    expect(paths).toEqual(["A.js", "a.js", "b.js"]);
  });

  it("walks a directory into posix-style entry paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ota-zip-"));
    await mkdir(join(dir, "assets", "img"), { recursive: true });
    await writeFile(join(dir, "index.js"), "main");
    await writeFile(join(dir, "assets", "img", "logo.png"), "png");

    const entries = await collectEntries(dir);
    expect(entries.map((e) => e.path)).toEqual(["assets/img/logo.png", "index.js"]);
  });
});
