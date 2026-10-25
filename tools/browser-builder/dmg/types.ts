/** read() fills at most buffer.length bytes; 0 is EOF. Partial reads are valid. */
export interface DmgReader {
  read(buffer: Uint8Array): Promise<number> | number;
  close?(): Promise<void> | void;
}
export interface DmgEntry {
  path: string;
  size: number;
  /** Permissions, or permissions plus S_IFREG/S_IFDIR. No special mode bits. */
  mode: number;
  type?: "file" | "directory";
  /** Optional conversion digest; resource sealing verifies it before signing. */
  expectedSha256?: string;
  open?: () => Promise<DmgReader> | DmgReader;
}
/** write must consume/copy bytes before resolving: the buffer is reused. */
export interface DmgSink { write(bytes: Uint8Array): Promise<void> | void }
export interface DmgOptions {
  volumeName?: string;
  chunkSize?: number;
  timestamp?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { writtenBytes: number; volumeBytes: number; path?: string }) => void;
  /** Awaited once per file after payload/padding writes and reader close; may release private input. */
  onFileWritten?: (entry: DmgEntry) => void | Promise<void>;
}
export interface DmgResult {
  volumeBytes: number;
  imageBytes: number;
  dataChecksum: number;
  fileCount: number;
  metadataBytes: number;
}
export interface RandomReader { size: number; read(offset: number, size: number): Promise<Uint8Array> }
