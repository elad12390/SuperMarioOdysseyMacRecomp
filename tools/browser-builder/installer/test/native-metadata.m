#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>

// Read-only test helper. No application/window creation, UI or automatic mounting.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4) return 64;
    NSImage *image = [[NSImage alloc] initWithContentsOfFile:@(argv[1])];
    NSData *alias = [NSData dataWithContentsOfFile:@(argv[2])];
    if (!image || !alias) return 65;
    CFDataRef bookmark = CFURLCreateBookmarkDataFromAliasRecord(kCFAllocatorDefault, (__bridge CFDataRef)alias);
    if (!bookmark) return 66;
    CFErrorRef error = NULL; Boolean stale = false;
    CFURLRef resolved = CFURLCreateByResolvingBookmarkData(kCFAllocatorDefault, bookmark,
      kCFBookmarkResolutionWithoutUIMask | kCFBookmarkResolutionWithoutMountingMask, NULL, NULL, &stale, &error);
    CFRelease(bookmark);
    if (!resolved) { if (error) { CFShow(error); CFRelease(error); } return 67; }
    NSString *path = [(__bridge NSURL *)resolved path];
    NSDictionary *result = @{ @"width": @(image.size.width), @"height": @(image.size.height), @"resolved": path, @"stale": @(stale) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL];
    fwrite(json.bytes, 1, json.length, stdout); putchar('\n');
    BOOL matches = [[path stringByStandardizingPath] isEqualToString:[[@(argv[3]) stringByStandardizingPath] stringByResolvingSymlinksInPath]];
    CFRelease(resolved);
    return matches && image.size.width == 777 && image.size.height == 604 ? 0 : 68;
  }
}
