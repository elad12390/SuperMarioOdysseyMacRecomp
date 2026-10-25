/* Original test-only executable. No game code or native image creation. */
#include <mach-o/dyld.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char executable[4096];
    uint32_t length = sizeof(executable);
    if (_NSGetExecutablePath(executable, &length) != 0) return 10;
    char *last = strrchr(executable, '/');
    if (!last) return 11;
    *last = 0;
    char resource[8192];
    snprintf(resource, sizeof(resource), "%s/../Resources/message.txt", executable);
    FILE *file = fopen(resource, "rb");
    if (!file) return 12;
    char content[256] = {0};
    size_t count = fread(content, 1, sizeof(content) - 1, file);
    fclose(file);
    if (strcmp(content, "browser-dmg-resource-ok\n") != 0 || count != 24) return 13;
    printf("browser-dmg-arm64-ok: %s", content);
    return 0;
}
