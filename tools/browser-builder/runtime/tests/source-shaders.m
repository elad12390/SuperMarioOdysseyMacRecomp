#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import "../source-shaders.h"
int main(int argc,const char **argv){@autoreleasepool{
 if(argc!=2)return 2;
 id<MTLDevice> device=MTLCreateSystemDefaultDevice();if(!device){fprintf(stderr,"No real Metal device available\n");return 3;}
 NSError *error=nil;BOOL layer=NO;
 id<MTLLibrary> lib=sr_compile_metal_source(device,[NSString stringWithUTF8String:argv[1]],&layer,&error);
 if(!lib){fprintf(stderr,"%s\n",error.localizedDescription.UTF8String);return 1;}
 if(![lib.functionNames containsObject:@"main0"]){fprintf(stderr,"Missing real entrypoint\n");return 1;}
 printf("PASS: compiled real source library on %s with preserveInvariance; %lu entrypoints; layer=%d\n",device.name.UTF8String,(unsigned long)lib.functionNames.count,layer);return 0;
}}
