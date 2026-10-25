import { createShaderTranslator } from './shader-translator.mjs';

let ready;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'init') {
      if (ready) throw new Error('Shader worker was already initialized.');
      ready = (async () => {
        const maxwell = await createShaderTranslator();
        let msl;
        if (data.mslTranslatorUrl) {
          const { createMslTranslator } = await import(data.mslTranslatorUrl);
          msl = await createMslTranslator();
        }
        return { maxwell, msl };
      })();
      await ready;
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (type !== 'translate-batch') throw new Error('Unknown shader worker request.');
    if (!ready) throw new Error('Initialize the shader worker first.');
    const { maxwell, msl } = await ready;
    const outputs = maxwell.translateBatch(data.entries);
    if (msl) for (const output of outputs) {
      const job = data.entries.find(entry => entry.job.key === output.key).job;
      if (job.stage === 'gs' && job.geometry_topology == null) output.glsl = msl.translateGlsl(output.spirv);
      else output.msl = msl.translate(output.spirv);
    }
    const transfer = outputs.flatMap(output => [output.spirv.buffer, ...(output.readerSpirv ? [output.readerSpirv.buffer] : [])]);
    self.postMessage({ id, type: 'result', outputs }, transfer);
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
