#import "source-shaders.h"

id<MTLLibrary> sr_compile_metal_source(id<MTLDevice> device, NSString *libraryPath,
                                     BOOL *usesLayer, NSError **error) {
    NSString *sourcePath = [libraryPath.stringByDeletingPathExtension stringByAppendingPathExtension:@"metal"];
    NSString *source = [NSString stringWithContentsOfFile:sourcePath encoding:NSUTF8StringEncoding error:error];
    if (!source) return nil;
    if (usesLayer) *usesLayer = [source containsString:@"render_target_array_index"];
    MTLCompileOptions *options = [MTLCompileOptions new];
    options.languageVersion = MTLLanguageVersion2_3;
    // Matches the existing offline compiler's -fpreserve-invariance. Odyssey's
    // depth prepass and G-buffer must agree exactly on vertex positions.
    options.preserveInvariance = YES;
    return [device newLibraryWithSource:source options:options error:error];
}
