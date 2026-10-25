// SPDX-License-Identifier: MIT
#include "spirv_msl.hpp"
#include "spirv_glsl.hpp"
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

static std::string output;
static std::string error;

extern "C" const char* shader_cross_error() { return error.c_str(); }
static std::vector<uint32_t> spirv_words(const uint8_t* bytes, size_t size)
{
    if (size < 20 || size % 4 != 0) throw std::runtime_error("Invalid SPIR-V byte length.");
    std::vector<uint32_t> words(size / 4);
    std::memcpy(words.data(), bytes, size);
    if (words[0] != 0x07230203) throw std::runtime_error("Invalid SPIR-V magic.");
    return words;
}
extern "C" const char* shader_cross(const uint8_t* bytes, size_t size, uint32_t version)
{
    output.clear(); error.clear();
    try
    {
        spirv_cross::CompilerMSL compiler(spirv_words(bytes, size));
        auto options = compiler.get_msl_options();
        options.msl_version = version;
        options.argument_buffers = true;
        options.texture_buffer_native = true;
        options.pad_fragment_output_components = true;
        compiler.set_msl_options(options);
        output = compiler.compile();
        return output.c_str();
    }
    catch (const std::exception& exception)
    {
        error = exception.what();
        return nullptr;
    }
}

extern "C" const char* shader_cross_glsl(const uint8_t* bytes, size_t size, uint32_t version)
{
    output.clear(); error.clear();
    try
    {
        spirv_cross::CompilerGLSL compiler(spirv_words(bytes, size));
        auto options = compiler.get_common_options();
        options.version = version;
        options.es = false;
        compiler.set_common_options(options);
        output = compiler.compile();
        return output.c_str();
    }
    catch (const std::exception& exception)
    {
        error = exception.what();
        return nullptr;
    }
}
