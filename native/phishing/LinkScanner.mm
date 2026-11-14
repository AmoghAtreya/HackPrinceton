#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <algorithm>
#include <chrono>
#include <vector>

namespace {
id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(value);
}

CGRect frame(AXUIElementRef element) {
    id position = attribute(element, kAXPositionAttribute);
    id size = attribute(element, kAXSizeAttribute);
    CGPoint point;
    CGSize dimensions;
    if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID() ||
        !AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &point) ||
        !AXValueGetValue((__bridge AXValueRef)size, kAXValueTypeCGSize, &dimensions)) return CGRectNull;
    return CGRectMake(point.x, point.y, dimensions.width, dimensions.height);
}

pid_t frontChrome() {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    return [front.bundleIdentifier isEqualToString:@"com.google.Chrome"] ? front.processIdentifier : 0;
}

struct Scan {
    pid_t pid = 0;
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    NSData *result = nil;
};

struct Entry {
    id element;
    CGRect viewport;
};

void collect(napi_env, void *data) {
    @autoreleasepool {
        auto &scan = *static_cast<Scan *>(data);
        NSMutableArray *links = [NSMutableArray array];
        id browser = CFBridgingRelease(AXUIElementCreateApplication(scan.pid));
        AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)browser, 0.08);
        id window = attribute((__bridge AXUIElementRef)browser, kAXFocusedWindowAttribute);
        std::vector<Entry> pending;
        if (window && CFGetTypeID((__bridge CFTypeRef)window) == AXUIElementGetTypeID())
            pending.push_back({window, CGRectNull});

        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(350);
        size_t visited = 0;
        while (!pending.empty() && visited < 1500 && links.count < 250 &&
               std::chrono::steady_clock::now() < deadline) {
            Entry entry = pending.back();
            pending.pop_back();
            ++visited;
            auto element = (__bridge AXUIElementRef)entry.element;
            id role = attribute(element, kAXRoleAttribute);
            if ([role isEqual:@"AXWebArea"]) entry.viewport = frame(element);
            if ([role isEqual:@"AXLink"] && !CGRectIsNull(entry.viewport)) {
                CGRect bounds = frame(element);
                id url = attribute(element, kAXURLAttribute);
                NSString *destination = [url isKindOfClass:NSURL.class] ? [url absoluteString] : nil;
                if (destination.length && destination.length <= 2048 &&
                    !CGRectIsEmpty(bounds) && CGRectContainsRect(entry.viewport, bounds)) {
                    [links addObject:@{ @"url": destination, @"x": @(CGRectGetMinX(bounds)),
                        @"y": @(CGRectGetMinY(bounds)), @"width": @(bounds.size.width),
                        @"height": @(bounds.size.height) }];
                }
            }
            CFArrayRef raw = nullptr;
            CFIndex remaining = static_cast<CFIndex>(1500 - visited - pending.size());
            CFIndex count = 0;
            if (remaining && AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute, &count) == kAXErrorSuccess &&
                count > 0 && AXUIElementCopyAttributeValues(element, kAXChildrenAttribute, 0, std::min(count, remaining), &raw) == kAXErrorSuccess) {
                NSArray *children = CFBridgingRelease(raw);
                for (id child in children.reverseObjectEnumerator) pending.push_back({child, entry.viewport});
            }
        }
        scan.result = [NSJSONSerialization dataWithJSONObject:links options:0 error:nil];
    }
}

void complete(napi_env env, napi_status status, void *data) {
    auto *scan = static_cast<Scan *>(data);
    napi_value result;
    NSData *bytes = status == napi_ok && frontChrome() == scan->pid ? scan->result : nil;
    napi_create_string_utf8(env, bytes ? static_cast<const char *>(bytes.bytes) : "[]",
                           bytes ? bytes.length : 2, &result);
    napi_resolve_deferred(env, scan->deferred, result);
    napi_delete_async_work(env, scan->work);
    delete scan;
}

napi_value scanLinks(napi_env env, napi_callback_info) {
    auto pid = frontChrome();
    napi_value result;
    if (!pid) {
        napi_create_string_utf8(env, "[]", 2, &result);
        return result;
    }
    auto *scan = new Scan;
    scan->pid = pid;
    napi_value name;
    napi_status status = napi_create_promise(env, &scan->deferred, &result);
    if (status == napi_ok) status = napi_create_string_utf8(env, "Triage link scan", NAPI_AUTO_LENGTH, &name);
    if (status == napi_ok) status = napi_create_async_work(env, nullptr, name, collect, complete, scan, &scan->work);
    if (status == napi_ok) status = napi_queue_async_work(env, scan->work);
    if (status != napi_ok) {
        if (scan->work) napi_delete_async_work(env, scan->work);
        delete scan;
        napi_throw_error(env, nullptr, "Could not schedule link scan");
        return nullptr;
    }
    return result;
}

napi_value initialize(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "scanLinks", NAPI_AUTO_LENGTH, scanLinks, nullptr, &function);
    napi_set_named_property(env, exports, "scanLinks", function);
    return exports;
}
}

NAPI_MODULE(triage_link_scanner, initialize)
