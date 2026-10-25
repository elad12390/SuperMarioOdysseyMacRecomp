export async function createMslTranslator({ moduleUrl = new URL('./spirv-cross.mjs', import.meta.url) } = {}) {
  const { default: createModule } = await import(String(moduleUrl));
  const module = await createModule();
  function compile(spirv, version, glsl) {
      if (!(spirv instanceof Uint8Array)) throw new TypeError('SPIR-V must be Uint8Array.');
      if (!Number.isInteger(version) || version <= 0) throw new TypeError('Shader language version must be a positive integer.');
      const ptr = module._malloc(spirv.length);
      if (!ptr) throw new Error('Unable to allocate SPIR-V input.');
      try {
        module.HEAPU8.set(spirv, ptr);
        const result = glsl ? module._shader_cross_glsl(ptr, spirv.length, version) : module._shader_cross(ptr, spirv.length, version);
        if (!result) throw new Error('SPIRV-Cross: ' + module.UTF8ToString(module._shader_cross_error()));
        return module.UTF8ToString(result);
      } finally {
        module._free(ptr);
      }
  }
  return {
    translate(spirv, { version = 20300 } = {}) { return compile(spirv, version, false); },
    // Exactly the desktop GLSL path used by dmsh_build.py gs_slice(): --version 450.
    translateGlsl(spirv, { version = 450 } = {}) { return compile(spirv, version, true); },
  };
}
