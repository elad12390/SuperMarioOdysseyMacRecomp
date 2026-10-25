/**
 * One page owns each switchrecomp/<UUID> directory through a Web Locks lease.
 * Keep the returned job through the completed download; worker termination or
 * build completion must not release it. Call remove() before replacing a job
 * or discarding its download. Closing the page releases the lock automatically;
 * the next acquisition reclaims its directory. Failed removal keeps the lease
 * for retry. All tabs using this namespace must follow this locking contract.
 */
export interface BuildJob {
  id: string;
  remove(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const guidance = 'Build storage requires Web Locks and private browser file storage. Use a current Chrome or Edge browser over HTTPS (or localhost), with site storage enabled.';
const lockName = (id: string) => `switchrecomp:job:${id}`;
const isMissing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';

async function reserve(id: string): Promise<() => Promise<void>> {
  let unlock!: () => void;
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const held = navigator.locks.request(lockName(id), { mode: 'exclusive', ifAvailable: true }, lock => {
    if (!lock) throw new Error('Could not reserve a unique build job. Try again.');
    return new Promise<void>(resolve => { unlock = resolve; acquired(); });
  });
  void held.catch(failed);
  await ready;
  return async () => { unlock(); await held; };
}

export async function acquireBuildJob(): Promise<BuildJob> {
  if (!navigator.locks?.request || !navigator.storage?.getDirectory || !crypto.randomUUID) {
    throw new Error(guidance);
  }
  let directory: FileSystemDirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle('switchrecomp', { create: true });
  } catch (cause) {
    throw new Error(guidance, { cause });
  }

  // An exclusive, nonwaiting lock is the only evidence that a job is stale.
  for await (const [id, entry] of directory.entries()) {
    if (entry.kind !== 'directory' || !UUID.test(id)) continue;
    await navigator.locks.request(lockName(id), { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) return;
      try { await directory.removeEntry(id, { recursive: true }); }
      catch (error) { if (!isMissing(error)) throw error; }
    });
  }

  const id = crypto.randomUUID();
  if (!UUID.test(id)) throw new Error('The browser did not generate a valid build UUID.');
  const release = await reserve(id);
  try {
    // Never reuse an existing name, even in the unlikely event of a UUID clash.
    let exists = false;
    try { await directory.getDirectoryHandle(id); exists = true; }
    catch (error) { if (!isMissing(error)) throw error; }
    if (exists) throw new Error('The build directory already exists. Try again.');
    await directory.getDirectoryHandle(id, { create: true });
  } catch (error) {
    await release();
    throw error;
  }

  let removed = false;
  let removing: Promise<void> | undefined;
  return {
    id,
    remove() {
      if (removed) return Promise.resolve();
      if (removing) return removing;
      removing = (async () => {
        try { await directory.removeEntry(id, { recursive: true }); }
        catch (error) { if (!isMissing(error)) throw error; }
        removed = true;
        await release();
      })().finally(() => { removing = undefined; });
      return removing;
    },
  };
}
