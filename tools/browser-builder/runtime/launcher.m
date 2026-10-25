// The distributable entry point resolves its own bundle, never a build checkout.
#import <Cocoa/Cocoa.h>
#include <unistd.h>

static BOOL cliValidation = NO;

static void fail(NSString *message) {
    if (cliValidation) {
        fprintf(stderr, "%s\n", message.UTF8String);
        exit(1);
    }
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Super Mario Odyssey could not start";
    alert.informativeText = message;
    [alert runModal];
    exit(1);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        cliValidation = argc == 2 && strcmp(argv[1], "--describe") == 0;
        NSString *resources = NSBundle.mainBundle.resourcePath;
        NSString *game = [resources stringByAppendingPathComponent:@"game"];
        NSString *host = [NSBundle.mainBundle.executablePath.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"dmhost"];
        NSFileManager *fm = NSFileManager.defaultManager;
        NSURL *support = [fm URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:nil];
        NSURL *profile = [[support URLByAppendingPathComponent:@"SwitchRecomp"] URLByAppendingPathComponent:@"Super Mario Odyssey"];
        // Only the dedicated test launcher opts into a private throwaway profile.
        const char *test = getenv("SWITCHRECOMP_TEST_ROOT");
        if (test && *test) {
            NSString *requested = [NSString stringWithUTF8String:test];
            if (!requested.isAbsolutePath) fail(@"The isolated test profile must use an absolute directory path.");
            requested = requested.stringByStandardizingPath.stringByResolvingSymlinksInPath;
            NSString *player = profile.path.stringByStandardizingPath.stringByResolvingSymlinksInPath;
            if ([requested isEqualToString:player] || [requested hasPrefix:[player stringByAppendingString:@"/"]]) fail(@"The isolated test profile must be separate from the Player profile.");
            profile = [NSURL fileURLWithPath:requested isDirectory:YES];
        }
        NSDictionary<NSString *, NSString *> *paths = @{
            @"DM_ROOT": game,
            @"DM_ROMFS": [game stringByAppendingPathComponent:@"extract/v0/RomFS"],
            @"DM_MSL_DIR": [game stringByAppendingPathComponent:@"shader/cache"],
            @"DM_FONT_DIR": [game stringByAppendingPathComponent:@"font"],
            @"DM_NVN_SHMAP": [game stringByAppendingPathComponent:@"profile/0100000000010000/shader_map.tsv"],
            @"DM_SAVE": [[profile URLByAppendingPathComponent:@"saves/Player"] path],
            @"DM_TEMP": [[profile URLByAppendingPathComponent:@"temporary"] path],
            @"DM_NATIVE_OPTIONS": [[profile URLByAppendingPathComponent:@"graphics.ini"] path]
        };
        if (cliValidation) {
            NSMutableDictionary *description = paths.mutableCopy;
            description[@"host"] = host;
            description[@"workingDirectory"] = profile.path;
            NSData *data = [NSJSONSerialization dataWithJSONObject:description options:NSJSONWritingPrettyPrinted error:nil];
            fwrite(data.bytes, 1, data.length, stdout);
            return 0;
        }
        for (NSString *required in @[@"patched_v0/main.patched.bin", @"patched_v0/subsdk0.patched.bin", @"patched_v0/sdk.patched.bin", @"profile/0100000000010000/shader_map.tsv"]) {
            if (![fm fileExistsAtPath:[game stringByAppendingPathComponent:required]]) fail(@"The game bundle is incomplete. Build it again from your original game dump.");
        }
        if (![fm isExecutableFileAtPath:host]) fail(@"The native runtime is missing or is not executable.");
        for (NSString *directory in @[profile.path, paths[@"DM_SAVE"], paths[@"DM_TEMP"]]) {
            NSError *error = nil;
            if (![fm createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:&error]) fail(error.localizedDescription);
        }
        // Finder must never inherit an automation save, replay, socket or renderer
        // override from the build process that launched it.
        NSArray *clear = @[@"DM_NATIVE_SOCKET", @"DM_CTL", @"DM_KEYS", @"DM_RUN_DIRECTORY", @"DM_AUDIO_RECORD", @"DM_AUDIO_CAPTURE", @"DM_SMO_TAS_MOTION", @"DM_SMO_LUNAKIT", @"DM_SMO_LUNAKIT_CONTINUOUS", @"DM_SMO_BRIDGE_OBSERVE", @"DM_NATIVE_HOST", @"DM_RENDER_FPS", @"DM_CAPTURE", @"DM_PREVIEW"];
        for (NSString *key in clear) unsetenv(key.UTF8String);
        for (NSString *key in paths) setenv(key.UTF8String, paths[key].UTF8String, 1);
        setenv("GAME_INSTANCE_ROLE", "player", 1);
        setenv("DM_INSTANCE_LABEL", "Player", 1);
        setenv("DM_AUTOMATED_INPUT", "0", 1);
        setenv("DM_WINDOW", "1", 1);
        setenv("DM_AUDIO", "1", 1);
        setenv("DM_MSL_SOURCE", "1", 1);
        setenv("DM_ARROW_CAMERA", "1", 1);
        setenv("DM_LANG", "en-US", 1);
        if (![fm fileExistsAtPath:paths[@"DM_NATIVE_OPTIONS"]]) [@"render_fps=0\nshow_fps=1\n" writeToFile:paths[@"DM_NATIVE_OPTIONS"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        NSString *log = [[profile URLByAppendingPathComponent:@"game.log"] path];
        if (!freopen(log.fileSystemRepresentation, "a", stdout) || !freopen(log.fileSystemRepresentation, "a", stderr)) fail(@"Could not open the game log in Application Support.");
        if (chdir(profile.path.fileSystemRepresentation)) fail(@"Could not open the game profile directory.");
        NSString *patched = [game stringByAppendingPathComponent:@"patched_v0"];
        execl(host.fileSystemRepresentation, host.fileSystemRepresentation, patched.fileSystemRepresentation, NULL);
        fail(@"macOS could not launch the native runtime.");
    }
}
