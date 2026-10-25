import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repoRoot } from './assemble.mjs';

export async function defaultAssets(root = repoRoot) {
  const scratch = path.join(root, 'tmp/odyssey/browser-release-tools');
  async function first(candidates, label) {
    for (const name of candidates) try { await access(name); return name; } catch { }
    throw new Error(`${label} is missing. Supply its explicit built asset path; no placeholder is produced.`);
  }
  return {
    extractorWwwroot: await first([path.join(root, 'tmp/odyssey/browser-extractor/publish/wwwroot'), path.join(scratch, 'build-root/tmp/odyssey/browser-extractor/publish/wwwroot')], 'Published extractor wwwroot'),
    rewriterBundle: path.join(root, 'tmp/odyssey/browser-rewriter/bundle'),
    shaderPipelineBundle: path.join(root, 'tmp/odyssey/browser-shader-chain/bundle'),
    nugetAssets: {
      extractor: await first([path.join(root, 'tmp/odyssey/browser-extractor/obj/project.assets.json'), path.join(scratch, 'build-root/tmp/odyssey/browser-extractor/obj/project.assets.json')], 'Extractor NuGet resolution'),
      shaders: path.join(root, 'tmp/odyssey/browser-shaders/dotnet/obj/ShaderTranslator/project.assets.json'),
    },
    dotnetRuntimePack: await first([
      ...(process.env.DOTNET_ROOT ? [path.join(process.env.DOTNET_ROOT, 'packs/Microsoft.NETCore.App.Runtime.Mono.browser-wasm/10.0.13')] : []),
      path.join(os.homedir(), '.dotnet/packs/Microsoft.NETCore.App.Runtime.Mono.browser-wasm/10.0.13'),
      '/opt/homebrew/opt/dotnet/libexec/packs/Microsoft.NETCore.App.Runtime.Mono.browser-wasm/10.0.13',
      '/usr/share/dotnet/packs/Microsoft.NETCore.App.Runtime.Mono.browser-wasm/10.0.13',
    ], '.NET browser runtime license pack 10.0.13'),
  };
}
