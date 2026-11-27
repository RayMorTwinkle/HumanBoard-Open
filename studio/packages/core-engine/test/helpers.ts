import type { Node, Scene } from "@humanboard/schema";

import type { Clock, IdGenerator } from "../src/domain/ports";
import type { Asset, Author, Project, Space, ULID } from "../src/domain/types";
import { OWNER_ID } from "../src/domain/types";
import { DraftService } from "../src/services/draft-service";
import { MemoryStorageAdapter } from "../src/storage/memory-storage-adapter";

export const TEST_AUTHOR: Author = {
  kind: "cli",
  name: "test-agent",
};

export class FakeClock implements Clock {
  private currentMs = Date.parse("2026-10-22T00:00:00.000Z");

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }
}

export class SequenceIds implements IdGenerator {
  private sequence = 1;

  next(): ULID {
    return `01ARZ3NDEK${String(this.sequence++).padStart(16, "0")}`;
  }
}

export interface Fixture {
  readonly storage: MemoryStorageAdapter;
  readonly service: DraftService;
  readonly clock: FakeClock;
  readonly ids: SequenceIds;
  readonly project: Project;
  readonly space: Space;
}

export async function createFixture(): Promise<Fixture> {
  const storage = new MemoryStorageAdapter();
  const clock = new FakeClock();
  const ids = new SequenceIds();

  const project: Project = {
    id: ids.next(),
    name: "test-project",
    root: "/tmp/test-project",
    owner_id: OWNER_ID,
    created_at: clock.now().toISOString(),
  };
  await storage.createProject(project);

  const space: Space = {
    id: ids.next(),
    project_id: project.id,
    name: "main",
    active_layer_id: null,
    owner_id: OWNER_ID,
    created_at: clock.now().toISOString(),
  };
  await storage.createSpace(space);

  return {
    storage,
    service: new DraftService({ storage, clock, ids }),
    clock,
    ids,
    project,
    space,
  };
}

export async function createAdditionalSpace(
  fixture: Fixture,
  name: string,
): Promise<Space> {
  const space: Space = {
    id: fixture.ids.next(),
    project_id: fixture.project.id,
    name,
    active_layer_id: null,
    owner_id: OWNER_ID,
    created_at: fixture.clock.now().toISOString(),
  };
  return fixture.storage.createSpace(space);
}

export function node(id: string, title = id): Node {
  return {
    id,
    kind: "note",
    title,
    rect: { x: 10, y: 20, w: 120, h: 60 },
  };
}

export function sceneWithNode(id: string, title = id): Scene {
  return {
    nodes: [node(id, title)],
    edges: [],
    strokes: [],
    assets: [],
  };
}

export function sceneWithAsset(assetId: ULID, displayNo: string): Scene {
  return {
    nodes: [],
    edges: [],
    strokes: [],
    assets: [
      {
        asset_id: assetId,
        display_no: displayNo,
        rect: { x: 0, y: 0, w: 320, h: 180 },
        z: 1,
      },
    ],
  };
}

export async function createImageAsset(
  fixture: Fixture,
  spaceId: ULID,
  displayNo: string,
): Promise<Asset> {
  const asset: Asset = {
    asset_id: fixture.ids.next(),
    space_id: spaceId,
    display_no: displayNo,
    type: "image",
    title: "screenshot",
    title_source: "pending",
    blob_hash: `sha256:${"a".repeat(64)}`,
    source_url: null,
    owner_id: OWNER_ID,
    created_at: fixture.clock.now().toISOString(),
  };
  return fixture.storage.createAsset(asset);
}

export async function commitRoot(
  fixture: Fixture,
  sessionId = "root-session",
  scene = sceneWithNode("root-node"),
): Promise<{
  layerId: ULID;
  seq: number;
}> {
  const created = await fixture.service.createDraft({
    sessionId,
    projectId: fixture.project.id,
    spaceId: fixture.space.id,
    kind: "root",
    scene,
    author: TEST_AUTHOR,
  });
  const committed = await fixture.service.commitDraft({
    sessionId,
    draftId: created.draft.id,
  });
  return {
    layerId: committed.layer.id,
    seq: committed.layer.seq,
  };
}
