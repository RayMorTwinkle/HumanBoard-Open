export interface BlobAdapter {
  readBlob(hash: string): Promise<Uint8Array>;
  writeBlob(data: Uint8Array): Promise<`sha256:${string}`>;
}
