// Unit + integration tests for TaskCache.
//
// Architecture invariants that block the large-vault startup regression:
//   - hasTaskListItem null-cache rule: parse when metadata is unindexed,
//     skip only when metadata explicitly says "no task list items".
//   - ensureAll() never opens task-free files (large-vault regression root cause).
//   - Write-path resolveRef goes single-file (no implicit ensureAll).
//   - cache.changed fires AFTER reparse settles, so flatten() in the callback
//     is post-state.
//
// Run with: `node --test test/cache.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/cache.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outfile=test/.compiled/cache.bundle.js",
      "--alias:obsidian=./test/obsidian-stub.mjs",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild failed:\n" + result.stderr);
  }
}

compile();
// IMPORTANT: pull both `TaskCache` and `TFile` from the same bundle. If the
// test imports `TFile` from `obsidian-stub.mjs` directly, it gets a sibling
// class with the same shape; `instanceof TFile` inside the bundled cache
// then returns false for every event and the listeners no-op silently.
const { TaskCache, TFile } = await import("../test/.compiled/cache.bundle.js");

// ----------------------------------------------------------------------------
// Fake App — minimum surface needed by TaskCache and parseFileTasks.
//
// Each spec file carries:
//   - path, content
//   - hasTask: did Obsidian's metadataCache index it AND see a task list item?
//   - metaIndexed: has metadata been indexed at all? null/undefined = not yet
//
// `hasTask=false, metaIndexed=true` → confirmed task-free. cache must skip.
// `metaIndexed=false` → not yet indexed. cache must parse (#1 large-vault regression).
// ----------------------------------------------------------------------------

function mkFile(spec) {
  const f = new TFile();
  f.path = spec.path;
  f.extension = spec.path.endsWith(".md") ? "md" : "txt";
  f.stat = { mtime: spec.mtime ?? 1000 };
  f._content = spec.content ?? "";
  f._hasTask = spec.hasTask ?? false;
  f._metaIndexed = spec.metaIndexed ?? true;
  f._parseFails = spec.parseFails ?? false;
  return f;
}

function makeApp(specs) {
  const files = specs.map(mkFile);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const metaListeners = []; // {event,cb}
  const vaultListeners = []; // {event,cb}

  return {
    _files: files,
    _byPath: byPath,

    vault: {
      getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
      getAbstractFileByPath: (p) => byPath.get(p) ?? null,
      cachedRead: async (f) => {
        if (f._parseFails) throw new Error("simulated read failure");
        return f._content;
      },
      on: (event, cb) => {
        const ref = { event, cb };
        vaultListeners.push(ref);
        return ref;
      },
    },

    metadataCache: {
      getFileCache: (f) => {
        if (!f._metaIndexed) return null;
        if (f._hasTask) {
          return {
            listItems: [
              { task: " ", position: { start: { line: 0 } }, parent: -1 },
            ],
          };
        }
        return { listItems: [] };
      },
      on: (event, cb) => {
        const ref = { event, cb };
        metaListeners.push(ref);
        return ref;
      },
    },

    /** Fire a metadataCache.changed for the named file (simulates Obsidian indexing). */
    _fireMetaChanged(path) {
      const f = byPath.get(path);
      if (!f) return;
      for (const l of metaListeners) if (l.event === "changed") l.cb(f);
    },

    /** Fire a vault event (delete / rename / etc). */
    _fireVault(event, ...args) {
      for (const l of vaultListeners) if (l.event === event) l.cb(...args);
    },

    _setContent(path, content) {
      const f = byPath.get(path);
      if (f) f._content = content;
    },

    _setHasTask(path, hasTask) {
      const f = byPath.get(path);
      if (f) f._hasTask = hasTask;
    },
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("ensureAll: skips metadata-confirmed task-free files (#1 large-vault regression fix)", async () => {
  // 6500 daily notes Obsidian has indexed and confirmed task-free, plus 50
  // task-bearing files. The pre-Phase-1 path read all 6550; the post-fix
  // path must only read 50.
  const specs = [];
  for (let i = 0; i < 6500; i++) {
    specs.push({ path: `Daily/d${i}.md`, hasTask: false, metaIndexed: true });
  }
  for (let i = 0; i < 50; i++) {
    specs.push({
      path: `Tasks/t${i}.md`,
      hasTask: true,
      metaIndexed: true,
      content: `- [ ] Task ${i}\n`,
    });
  }
  const app = makeApp(specs);
  const cache = new TaskCache(app);
  cache.bind();

  const t0 = Date.now();
  const tasks = await cache.ensureAll();
  const dt = Date.now() - t0;

  assert.equal(
    cache.__stats.parseCount,
    50,
    `parseCount must equal 50 (only task-bearing files), got ${cache.__stats.parseCount}`,
  );
  assert.equal(
    cache.__stats.skipCount,
    6500,
    `skipCount must equal 6500, got ${cache.__stats.skipCount}`,
  );
  assert.equal(tasks.length, 50);
  // Performance budget: 6550 mock files (50 actual reads, no real I/O) must
  // settle in well under a second on any dev machine. The point is that the
  // skip path is O(1) per file.
  assert.ok(dt < 1000, `ensureAll over 6550 mock files must finish < 1000ms, got ${dt}ms`);
});

test("ensureAll: parses files where metadata is not yet indexed (no false skip)", async () => {
  // metadata not yet indexed must NOT be treated as task-free — parser must
  // still see the bytes (#1 large-vault regression corollary).
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, metaIndexed: false, content: "- [ ] X\n" },
    { path: "Tasks/t2.md", hasTask: false, metaIndexed: false, content: "no tasks\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  // Both files must be parsed (we can't prove t2 has no tasks until we read).
  assert.equal(cache.__stats.parseCount, 2);
  assert.equal(cache.__stats.skipCount, 0);
});

test("invalidateFile: re-parses ONE file, emits cache.changed with that path", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] Old title\n" },
    { path: "Tasks/t2.md", hasTask: true, content: "- [ ] Untouched\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const beforeParseCount = cache.__stats.parseCount;
  const changedEvents = [];
  cache.on("changed", (paths) => changedEvents.push(new Set(paths)));

  // Edit t1 then fire metadataCache.changed (what Obsidian does after a write).
  app._setContent("Tasks/t1.md", "- [ ] New title\n");
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();

  assert.equal(
    cache.__stats.parseCount - beforeParseCount,
    1,
    "exactly ONE file should re-parse on a single metadataCache.changed event",
  );
  assert.equal(changedEvents.length, 1);
  assert.deepEqual(Array.from(changedEvents[0]), ["Tasks/t1.md"]);

  // Subscriber reading flatten() in the changed callback must see the new title.
  const tasksAfter = cache.flatten();
  const t1 = tasksAfter.find((t) => t.path === "Tasks/t1.md");
  assert.ok(t1, "t1 should still be in cache after invalidation");
  assert.match(t1.rawLine, /New title/);
});

test("resolveRef path:Lnnn — single-file resolve, never triggers ensureAll", async () => {
  const app = makeApp([
    { path: "Tasks/a.md", hasTask: true, content: "- [ ] Alpha\n" },
    { path: "Tasks/b.md", hasTask: true, content: "- [ ] Bravo\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  // Start from cold — never call ensureAll directly.

  const t = await cache.resolveRef("Tasks/a.md:L1");
  assert.ok(t, "should resolve a path:L1 ref directly");
  assert.equal(t.path, "Tasks/a.md");
  assert.equal(t.line, 0);

  assert.equal(
    cache.__stats.ensureCount,
    0,
    "path:L resolve must not trigger a full ensureAll",
  );
  // Only the requested file was parsed.
  assert.equal(cache.__stats.parseCount, 1);
});

test("resolveRef hash — falls back to ensureAll only on first miss", async () => {
  const app = makeApp([
    { path: "Tasks/a.md", hasTask: true, content: "- [ ] Alpha\n" },
    { path: "Tasks/b.md", hasTask: true, content: "- [ ] Bravo\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();
  const tasks = cache.flatten();
  const targetHash = tasks[0].hash;

  const found = await cache.resolveRef(targetHash);
  assert.ok(found);
  assert.equal(found.hash, targetHash);
  // ensureAll already happened above, no extra one.
  assert.equal(cache.__stats.ensureCount, 1);
});

test("invalidateFile dedups concurrent in-flight invocations", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] X\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const before = cache.__stats.parseCount;
  // Three concurrent invalidations of the same path must coalesce.
  const ps = [
    cache.invalidateFile("Tasks/t1.md"),
    cache.invalidateFile("Tasks/t1.md"),
    cache.invalidateFile("Tasks/t1.md"),
  ];
  await Promise.all(ps);

  assert.equal(
    cache.__stats.parseCount - before,
    1,
    "concurrent invalidateFile calls for the same path must produce exactly one parse",
  );
});

test("parse error in one file: console.warn, others continue (mapLimit isolation)", async () => {
  const app = makeApp([
    { path: "Tasks/ok.md", hasTask: true, content: "- [ ] OK\n" },
    { path: "Tasks/fail.md", hasTask: true, parseFails: true },
    { path: "Tasks/ok2.md", hasTask: true, content: "- [ ] OK2\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  // Suppress the expected warning so test output stays clean.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await cache.ensureAll();
  } finally {
    console.warn = origWarn;
  }

  assert.ok(
    cache.__stats.parseErrCount >= 1,
    `parseErrCount should bump on read failure, got ${cache.__stats.parseErrCount}`,
  );
  // Other two files parsed successfully — failure does not poison the batch.
  assert.equal(cache.__stats.parseCount, 2);
  const tasks = cache.flatten();
  const paths = tasks.map((t) => t.path).sort();
  assert.deepEqual(paths, ["Tasks/ok.md", "Tasks/ok2.md"]);
});

test("delete event: drops the file's tasks from cache, emits changed", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] One\n" },
    { path: "Tasks/t2.md", hasTask: true, content: "- [ ] Two\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();

  const events = [];
  cache.on("changed", (paths) => events.push(new Set(paths)));

  // Simulate Obsidian deleting the file.
  const t1 = app._byPath.get("Tasks/t1.md");
  app._byPath.delete("Tasks/t1.md");
  app._files.splice(app._files.indexOf(t1), 1);
  app._fireVault("delete", t1);

  const remaining = cache.flatten();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].path, "Tasks/t2.md");
  assert.ok(events.length >= 1);
  assert.ok(events[0].has("Tasks/t1.md"));
});

test("dispose: clears state and unsubscribes listeners", async () => {
  const app = makeApp([
    { path: "Tasks/t1.md", hasTask: true, content: "- [ ] One\n" },
  ]);
  const cache = new TaskCache(app);
  cache.bind();
  await cache.ensureAll();
  assert.equal(cache.flatten().length, 1);

  const events = [];
  cache.on("changed", (paths) => events.push(paths));

  cache.dispose();

  assert.equal(cache.flatten().length, 0);
  // After dispose, listeners are cleared — firing changed must not call them.
  app._fireMetaChanged("Tasks/t1.md");
  await cache.forFlush();
  assert.equal(events.length, 0);
});
