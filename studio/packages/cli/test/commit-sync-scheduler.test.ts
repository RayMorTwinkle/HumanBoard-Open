import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanBoardError } from "@humanboard/core-engine";

import {
  CommitEventBus,
  type CommitEvent,
} from "../src/commit-event-bus";
import {
  CommitSyncScheduler,
  DEFAULT_SYNC_DEBOUNCE_MS,
} from "../src/commit-sync-scheduler";
import type { ServerConfig } from "../src/client-actions";
import { resolveRuntimePaths } from "../src/config";
import type { SyncTransport } from "../src/sync-client";

const temporaryDirectories: string[] = [];
const CONFIG: ServerConfig = {
  server_url: "http://127.0.0.1:4317/",
  token: "test-token",
};

const transport = {
  negotiateRemote: async () => {
    throw new Error("not used");
  },
  pullRemoteLayer: async () => {
    throw new Error("not used");
  },
  pullRemoteBlob: async () => {
    throw new Error("not used");
  },
  pushRemote: async () => {
    throw new Error("not used");
  },
} satisfies SyncTransport;

function commitEvent(
  overrides: Partial<CommitEvent> = {},
): CommitEvent {
  return {
    event: "layer_committed",
    layer_id: "01M5H4QFEDB0X44RK6VWW58FCZ",
    project_id: "01M5H4QEZ3SN0ZSG290VS2AJSB",
    space_id: "01M5H4QF1X6ZAV7T51WCTBMTSC",
    seq: 1,
    short_id: "L1",
    parent_id: null,
    kind: "root",
    title: "root",
    title_source: "agent",
    author: { kind: "cli" },
    diff: { mode: "empty", summary: "" },
    ...overrides,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for scheduler");
    }
    await delay(10);
  }
}

async function pathsFixture(): Promise<{
  readonly cwd: string;
  readonly paths: ReturnType<typeof resolveRuntimePaths>;
}> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-scheduler-"));
  temporaryDirectories.push(root);
  const env = { HUMANBOARD_HOME: join(root, "home") };
  return {
    cwd: root,
    paths: resolveRuntimePaths(env, root),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("CommitSyncScheduler", () => {
  test("uses a 1.5 second default debounce", () => {
    expect(DEFAULT_SYNC_DEBOUNCE_MS).toBe(1500);
  });

  test("resets timers per Space and keeps different Spaces independent", async () => {
    const fixture = await pathsFixture();
    const events = new CommitEventBus();
    const pushed: CommitEvent[] = [];
    const scheduler = new CommitSyncScheduler({
      events,
      paths: fixture.paths,
      debounceMs: 40,
      readConfig: async () => CONFIG,
      checkHealth: async () => ({
        healthy: true,
        status: 200,
        reason: "healthy",
      }),
      createClient: () => transport,
      push: async (event) => {
        pushed.push(event);
      },
    });
    try {
      events.publish(commitEvent({ seq: 1, short_id: "L1" }));
      await delay(15);
      events.publish(commitEvent({ seq: 2, short_id: "L2" }));
      events.publish(
        commitEvent({
          layer_id: "01M5H4QFEDB0X44RK6VWW58FD0",
          space_id: "01M5H4QF1X6ZAV7T51WCTBMTSE",
          seq: 1,
          short_id: "L1",
        }),
      );

      await waitFor(() => pushed.length === 2);
      await delay(60);

      expect(pushed).toHaveLength(2);
      expect(
        pushed
          .filter((event) => event.space_id === commitEvent().space_id)
          .map((event) => event.seq),
      ).toEqual([2]);
      expect(
        pushed.filter(
          (event) => event.space_id === "01M5H4QF1X6ZAV7T51WCTBMTSE",
        ),
      ).toHaveLength(1);
      expect(scheduler.failures).toEqual([]);
    } finally {
      scheduler.dispose();
    }
  });

  test("does nothing when no server config exists", async () => {
    const fixture = await pathsFixture();
    const events = new CommitEventBus();
    let pushes = 0;
    const scheduler = new CommitSyncScheduler({
      events,
      paths: fixture.paths,
      debounceMs: 10,
      readConfig: async () => null,
      createClient: () => transport,
      push: async () => {
        pushes += 1;
      },
    });
    try {
      events.publish(commitEvent());
      await delay(60);
      expect(pushes).toBe(0);
      expect(scheduler.failures).toEqual([]);
    } finally {
      scheduler.dispose();
    }
  });

  test("skips push when remote health fails and records the failure", async () => {
    const fixture = await pathsFixture();
    const events = new CommitEventBus();
    let pushes = 0;
    const scheduler = new CommitSyncScheduler({
      events,
      paths: fixture.paths,
      debounceMs: 10,
      readConfig: async () => CONFIG,
      checkHealth: async () => ({
        healthy: false,
        status: null,
        reason: "network",
      }),
      createClient: () => transport,
      push: async () => {
        pushes += 1;
      },
    });
    try {
      events.publish(commitEvent());
      await waitFor(() => scheduler.failures.length === 1);
      expect(pushes).toBe(0);
      expect(scheduler.failures[0]).toMatchObject({
        code: "E_CONNECT",
        layer_id: commitEvent().layer_id,
      });
    } finally {
      scheduler.dispose();
    }
  });

  test("contains push failures without throwing from the event bus", async () => {
    const fixture = await pathsFixture();
    const events = new CommitEventBus();
    const scheduler = new CommitSyncScheduler({
      events,
      paths: fixture.paths,
      debounceMs: 10,
      readConfig: async () => CONFIG,
      checkHealth: async () => ({
        healthy: true,
        status: 200,
        reason: "healthy",
      }),
      createClient: () => transport,
      push: async () => {
        throw new HumanBoardError("E_CONNECT", "remote unavailable");
      },
    });
    try {
      expect(() => events.publish(commitEvent())).not.toThrow();
      await waitFor(() => scheduler.failures.length === 1);
      expect(scheduler.failures[0]).toMatchObject({
        code: "E_CONNECT",
        message: "remote unavailable",
      });
    } finally {
      scheduler.dispose();
    }
  });
});
