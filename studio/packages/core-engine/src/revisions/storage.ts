import type {
  AppendLayerInput,
  StorageAdapter,
} from "../storage/storage-adapter";

export interface RevisionPublication {
  spaceId: string;
  branch: string;
  expected: string | null;
  from: string;
  append?: AppendLayerInput;
  mergeParent?: string;
  source?: { name: string; head: string };
}

/** Publishing must compare both branch tips in the same transaction as the snapshot. */
export interface RevisionStorage extends StorageAdapter {
  revisionRefs(spaceId: string): { name: string; head: string }[];
  mergeParents(spaceId: string): { layer_id: string; source_id: string }[];
  publishRevision(input: RevisionPublication): string;
}
