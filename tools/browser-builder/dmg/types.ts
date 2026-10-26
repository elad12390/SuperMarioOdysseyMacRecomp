/** read() fills at most buffer.length bytes; 0 is EOF. Partial reads are valid. */
export interface DmgReader {
  read(buffer: Uint8Array): Promise<number> | number;
  close?(): Promise<void> | void;
}
export interface DmgEntry {
  path: string;
  size: number;
  /** Permissions, or permissions plus matching S_IFREG/S_IFDIR/S_IFLNK. No special bits. */
  mode: number;
  type?: "file" | "directory" | "symlink";
  /** Symlinks only: exact bounded UTF-8 target; size must match and open is forbidden. */
  target?: string;
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
  /** Existing relative directory to open in Finder; "" selects root. Omission leaves Finder info unchanged. */
  openFolder?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { writtenBytes: number; volumeBytes: number; path?: string }) => void;
  /** Awaited once per regular file or symlink after payload/padding and reader close. */
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
