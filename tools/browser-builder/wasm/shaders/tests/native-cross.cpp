#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include <string>
extern "C" const char* shader_cross(const uint8_t*, size_t, uint32_t);
extern "C" const char* shader_cross_glsl(const uint8_t*, size_t, uint32_t);
extern "C" const char* shader_cross_error();
int main(int argc, char** argv) {
  if (argc != 2 && (argc != 3 || std::string(argv[2]) != "--glsl")) return 2;
  std::ifstream file(argv[1], std::ios::binary);
  if (!file) return 2;
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), {});
  const char* result = argc == 3 ? shader_cross_glsl(bytes.data(), bytes.size(), 450) : shader_cross(bytes.data(), bytes.size(), 20300);
  if (!result) { std::cerr << shader_cross_error() << '\n'; return 1; }
  std::cout << result;
}
