import path from 'node:path';

export async function apiChecks(page, root) {
  await page.evaluate(() => { const picker = document.createElement('input'); picker.type = 'file'; picker.id = 'main-source'; document.body.append(picker); });
  await (await page.$('#main-source')).uploadFile(path.join(root, 'game-data/super-mario-odyssey/extract/v0/ExeFS/main'));
  return page.evaluate(async () => {
    const { run } = await import('/bundle/index.mjs');
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('api-checks', { recursive: true }).catch(() => {});
    const job = await root.getDirectoryHandle('api-checks', { create: true });
    const inputDirectory = await job.getDirectoryHandle('input', { create: true });
    const exefs = await inputDirectory.getDirectoryHandle('ExeFS', { create: true });
    const romfs = await inputDirectory.getDirectoryHandle('RomFS', { create: true });
    await (await (await romfs.getFileHandle('.empty', { create: true })).createWritable()).close();
    const file = document.querySelector('#main-source').files[0];
    const main = await exefs.getFileHandle('main', { create: true });
    await file.stream().pipeTo(await main.createWritable());
    const outputDirectory = await job.getDirectoryHandle('output', { create: true });
    const before = (await main.getFile()).size;
    const results = {};
    results.aliasRejected = await run({ inputDirectory, outputDirectory: inputDirectory }).then(() => false, () => true);
    if (!results.aliasRejected) throw new Error('Input/output alias was accepted');
    const marker = await outputDirectory.getFileHandle('keep.txt', { create: true });
    const writer = await marker.createWritable(); await writer.write('keep'); await writer.close();
    results.existingRejected = await run({ inputDirectory, outputDirectory }).then(() => false, () => true);
    if (!results.existingRejected || await (await marker.getFile()).text() !== 'keep') throw new Error('Existing output was changed');
    await outputDirectory.removeEntry('keep.txt');
    const controller = new AbortController();
    let actualSplitStarted = false;
    let abortError;
    results.activeAbort = await run({ inputDirectory, outputDirectory, signal: controller.signal }, event => {
      if (event.stage === 'split' && event.completed === 0) { actualSplitStarted = true; controller.abort(); }
    }).then(() => false, error => { abortError = { name: error.name, message: error.message, cleanupFailures: error.cleanupFailures }; return error.name === 'AbortError' && !error.cleanupFailures; });
    if (!results.activeAbort || !actualSplitStarted) throw new Error('Real Python split cancellation was not exercised: ' + JSON.stringify({ actualSplitStarted, abortError }));
    const remaining = []; for await (const name of outputDirectory.keys()) remaining.push(name);
    if (remaining.length) throw new Error('Abort left partial shader output: ' + remaining.join(','));
    results.abortCleaned = true;
    if ((await main.getFile()).size !== before) throw new Error('Cancellation changed the original module');
    results.inputPreserved = true;
    results.fingerprintRejected = await run({ inputDirectory, outputDirectory, bundleURL: new URL('/bad-bundle/', location.href).href }).then(() => false, error => /fingerprint mismatch/.test(error.message));
    if (!results.fingerprintRejected) throw new Error('Invalid browser tool chain was accepted');
    return results;
  });
}
