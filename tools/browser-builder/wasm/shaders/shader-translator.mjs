// All shader bytes remain in this worker's WASM memory. Serve only tool assets.
export async function createShaderTranslator({ frameworkUrl = new URL('./_framework/dotnet.js', import.meta.url) } = {}) {
  // .NET 10 otherwise mistakes a worker with an onmessage handler for a runtime pthread.
  // Select its standalone sidecar host before importing any .NET runtime modules.
  if (typeof importScripts === 'function') globalThis.dotnetSidecar = true;
  const { dotnet } = await import(String(frameworkUrl));
  const runtime = await dotnet.create();
  const assembly = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
  const api = assembly.BrowserShaders.ShaderTranslator;
  const decoder = new TextDecoder();
  return {
    api,
    // Run bounded batches in a dedicated worker; terminate the worker to cancel.
    translateBatch(entries) {
      if (!Array.isArray(entries)) throw new TypeError('Expected shader entries.');
      api.Reset();
      try {
        const jobs = entries.map(({ job, code }, index) => {
          if (!(code instanceof Uint8Array)) throw new TypeError('Shader code must be Uint8Array.');
          const path = '/in/' + index + '.bin';
          api.WriteFile(path, code);
          return { ...job, code: path };
        });
        const exitCode = api.Translate(JSON.stringify(jobs));
        const diagnostics = api.GetDiagnostics();
        if (exitCode !== 0) throw new Error('Maxwell shader translation failed: ' + diagnostics);
        return jobs.map(job => ({
          key: job.key,
          spirv: api.ReadFile('/out/' + job.key + '.spv'),
          resources: JSON.parse(decoder.decode(api.ReadFile('/out/' + job.key + '.res.json'))),
          readerSpirv: job.geometry_topology == null ? null : api.ReadFile('/out/' + job.key + '.reader.spv'),
        }));
      } finally {
        api.Reset();
      }
    },
  };
}
