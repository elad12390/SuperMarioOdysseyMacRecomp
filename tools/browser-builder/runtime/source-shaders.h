#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

// Called only for a missing offline library in a browser-generated game bundle.
id<MTLLibrary> sr_compile_metal_source(id<MTLDevice> device, NSString *libraryPath,
                                     BOOL *usesLayer, NSError **error);
