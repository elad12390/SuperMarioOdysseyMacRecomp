// Local app entry point; resolves this checkout instead of embedding its path.
#include <mach-o/dyld.h>
#include <sys/syslimits.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char executable[PATH_MAX], path[PATH_MAX];
    uint32_t size = sizeof executable;
    if (_NSGetExecutablePath(executable, &size) || !realpath(executable, path)) {
        perror("Locate Super Mario Odyssey app"); return 1;
    }
    // release/Game.app/Contents/MacOS/Launcher -> workspace root.
    for (int i = 0; i < 5; i++) {
        char *parent = dirname(path);
        memmove(path, parent, strlen(parent) + 1);
    }
    char launcher[PATH_MAX];
    if (snprintf(launcher, sizeof launcher, "%s/scripts/play-odyssey.command", path) >= (int)sizeof launcher) return 1;
    setenv("GAME_INSTANCE_ROLE", "player", 1);
    // Finder launches Player; an inherited test shell must not change its profile.
    const char *private[] = {"DM_SAVE", "DM_TEMP", "DM_NATIVE_OPTIONS", "DM_NATIVE_SOCKET", "DM_RUN_DIRECTORY", "DM_KEYS", "DM_SMO_TAS_MOTION", "DM_LAUNCH_LOG", NULL};
    for (int i = 0; private[i]; i++) unsetenv(private[i]);
    execl(launcher, launcher, (char *)NULL);
    perror("Launch Super Mario Odyssey"); return 1;
}
