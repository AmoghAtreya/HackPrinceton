#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

// Accessibility snapshot of the frontmost app's focused window. Generalizes
// native/phishing/LinkScanner.mm from "links in Chrome" to "labelled elements in
// any app". Privacy rule: AXValue is read ONLY for AXStaticText and AXHeading,
// and never for a secure text field, so typed input cannot leave the process.

namespace {
const size_t kMaxElements = 400;
const size_t kMaxNodes = 3000;
const NSUInteger kMaxLabel = 300;
const NSUInteger kMaxValue = 500;
const NSUInteger kMaxElementUrl = 2048;
const NSUInteger kMaxDocumentUrl = 4000;
const NSUInteger kMaxTitle = 500;
const size_t kMaxPath = 128;
const uint32_t kMaxChildIndex = 100000;
const char kEmpty[] = "{\"app\":{\"bundleId\":\"\",\"name\":\"\",\"pid\":0},"
    "\"window\":{\"title\":\"\",\"frame\":{\"x\":0,\"y\":0,\"width\":0,\"height\":0}},\"elements\":[]}";

// A batch read reports a missing attribute as an AXValue wrapping an AXError.
id present(id value) {
    if (!value || value == NSNull.null) return nil;
    auto ref = (__bridge CFTypeRef)value;
    if (CFGetTypeID(ref) == AXValueGetTypeID() && AXValueGetType((AXValueRef)ref) == kAXValueTypeAXError) return nil;
    return value;
}

id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return nil;
    return present(CFBridgingRelease(value));
}

// One IPC round trip for several attributes. Returns nil when the element is gone.
NSArray *attributes(AXUIElementRef element, NSArray *names) {
    CFArrayRef raw = nullptr;
    if (AXUIElementCopyMultipleAttributeValues(element, (__bridge CFArrayRef)names, 0, &raw) != kAXErrorSuccess) return nil;
    NSArray *values = CFBridgingRelease(raw);
    return values.count == names.count ? values : nil;
}

// Trimmed text capped at `limit` UTF-16 units without splitting a character.
NSString *text(id value, NSUInteger limit) {
    if ([value isKindOfClass:NSAttributedString.class]) value = [value string];
    if (![value isKindOfClass:NSString.class]) return nil;
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length > limit) {
        NSRange safe = [trimmed rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, limit)];
        if (safe.length > limit) safe.length = [trimmed rangeOfComposedCharacterSequenceAtIndex:limit].location;
        trimmed = [trimmed substringWithRange:safe];
    }
    return trimmed.length ? trimmed : nil;
}

NSString *urlText(id value, NSUInteger limit) {
    NSString *string = [value isKindOfClass:NSURL.class] ? [value absoluteString]
        : [value isKindOfClass:NSString.class] ? value : nil;
    return string.length && string.length <= limit ? string : nil;
}

CGRect rect(id position, id size) {
    CGPoint point;
    CGSize dimensions;
    if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID() ||
        !AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &point) ||
        !AXValueGetValue((__bridge AXValueRef)size, kAXValueTypeCGSize, &dimensions)) return CGRectNull;
    CGRect result = CGRectMake(point.x, point.y, dimensions.width, dimensions.height);
    const double limit = 1e6;
    if (!std::isfinite(result.origin.x) || !std::isfinite(result.origin.y) ||
        !std::isfinite(result.size.width) || !std::isfinite(result.size.height) ||
        std::fabs(result.origin.x) > limit || std::fabs(result.origin.y) > limit ||
        result.size.width > limit || result.size.height > limit) return CGRectNull;
    return result;
}

NSDictionary *frameObject(CGRect bounds) {
    return @{ @"x": @(CGRectGetMinX(bounds)), @"y": @(CGRectGetMinY(bounds)),
              @"width": @(bounds.size.width), @"height": @(bounds.size.height) };
}

// Unlabelled layout containers carry no meaning and would exhaust the element cap.
bool isLayoutRole(NSString *role) {
    static NSSet *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = [NSSet setWithArray:@[ @"AXGroup", @"AXScrollArea", @"AXSplitGroup", @"AXSplitter", @"AXLayoutArea",
            @"AXLayoutItem", @"AXList", @"AXOutline", @"AXTable", @"AXRow", @"AXColumn", @"AXCell", @"AXBrowser",
            @"AXTabGroup", @"AXToolbar", @"AXScrollBar", @"AXUnknown", @"AXGenericElement" ]];
    });
    return [roles containsObject:role];
}

// The app the person is looking at. When Triage itself is active (its chat has
// focus, or its windows were just hidden for a capture) that is the owner of the
// topmost ordinary window belonging to another process.
pid_t frontPid() {
    const pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    const pid_t self = getpid();
    if (front > 0 && front != self) return front;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *info in windows) {
        const pid_t owner = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        if (owner <= 0 || owner == self || [info[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds;
        id rawBounds = info[(__bridge NSString *)kCGWindowBounds];
        if (![rawBounds isKindOfClass:NSDictionary.class] ||
            !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rawBounds, &bounds) ||
            bounds.size.width < 40 || bounds.size.height < 40) continue;
        return owner;
    }
    return 0;
}

// The window snapshots and frame probes are both rooted at, so a recorded path means the same thing to each.
id focusedWindow(AXUIElementRef app) {
    for (CFStringRef name : { kAXFocusedWindowAttribute, kAXMainWindowAttribute }) {
        id window = attribute(app, name);
        if (window && CFGetTypeID((__bridge CFTypeRef)window) == AXUIElementGetTypeID()) return window;
    }
    return nil;
}

struct Scan {
    pid_t pid = 0;
    NSString *bundleId = @"";
    NSString *name = @"";
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    NSData *result = nil;
};

struct Entry {
    id element;
    int depth; // number of EMITTED ancestors, so consumers can rebuild ancestry from the flat list
    bool root;
    std::vector<uint32_t> path; // child indexes from the window, so frameOf() can find the element again
};

void collect(napi_env, void *data) {
    @autoreleasepool {
        auto &scan = *static_cast<Scan *>(data);
        id app = CFBridgingRelease(AXUIElementCreateApplication(scan.pid));
        auto appRef = (__bridge AXUIElementRef)app;
        AXUIElementSetMessagingTimeout(appRef, 0.08);
        id window = focusedWindow(appRef);
        if (!window) return;
        auto windowRef = (__bridge AXUIElementRef)window;
        CGRect windowFrame = rect(attribute(windowRef, kAXPositionAttribute), attribute(windowRef, kAXSizeAttribute));
        if (CGRectIsNull(windowFrame) || CGRectIsEmpty(windowFrame)) return;
        id focused = attribute(appRef, kAXFocusedUIElementAttribute);
        NSString *documentUrl = urlText(attribute(windowRef, kAXDocumentAttribute), kMaxDocumentUrl);

        NSArray *structure = @[ (__bridge NSString *)kAXRoleAttribute, (__bridge NSString *)kAXSubroleAttribute,
            (__bridge NSString *)kAXPositionAttribute, (__bridge NSString *)kAXSizeAttribute,
            (__bridge NSString *)kAXChildrenAttribute ];
        // AXValue is deliberately absent from both batches: it is fetched one
        // element at a time, after the role proves the element is prose.
        NSArray *details = @[ (__bridge NSString *)kAXTitleAttribute, (__bridge NSString *)kAXDescriptionAttribute,
            (__bridge NSString *)kAXPlaceholderValueAttribute, (__bridge NSString *)kAXHelpAttribute,
            (__bridge NSString *)kAXEnabledAttribute ];

        NSMutableArray *elements = [NSMutableArray array];
        NSInteger focusedIndex = -1;
        std::vector<Entry> pending;
        pending.push_back({window, 0, true, {}});
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(400);
        size_t visited = 0;
        while (!pending.empty() && visited < kMaxNodes && elements.count < kMaxElements &&
               std::chrono::steady_clock::now() < deadline) {
            Entry entry = pending.back();
            pending.pop_back();
            ++visited;
            auto element = (__bridge AXUIElementRef)entry.element;
            NSArray *base = attributes(element, structure);
            if (!base) continue;
            NSString *role = present(base[0]);
            if (![role isKindOfClass:NSString.class] || !role.length || role.length > 80) continue;
            NSString *subrole = present(base[1]);
            if (![subrole isKindOfClass:NSString.class] || !subrole.length || subrole.length > 80) subrole = nil;
            CGRect bounds = rect(present(base[2]), present(base[3]));
            bool emitted = false;

            if (!entry.root && !CGRectIsNull(bounds) && !CGRectIsEmpty(bounds) && CGRectIntersectsRect(windowFrame, bounds)) {
                const bool secure = [role isEqualToString:@"AXSecureTextField"] || [subrole isEqualToString:@"AXSecureTextField"];
                const bool prose = !secure && ([role isEqualToString:@"AXStaticText"] || [role isEqualToString:@"AXHeading"]);
                NSArray *detail = attributes(element, details);
                NSString *label = nil;
                for (NSUInteger index = 0; index < 4 && !label; index++) label = text(present(detail[index]), kMaxLabel);
                id enabledValue = present(detail[4]);
                const bool enabled = [enabledValue isKindOfClass:NSNumber.class] ? [enabledValue boolValue] : true;
                NSString *value = nil;
                if (prose) {
                    id raw = attribute(element, kAXValueAttribute);
                    // Web headings report their level as a number here.
                    value = [raw isKindOfClass:NSNumber.class] ? [raw stringValue] : text(raw, kMaxValue);
                }
                NSString *url = nil;
                const bool webArea = [role isEqualToString:@"AXWebArea"];
                if (webArea || [role isEqualToString:@"AXLink"]) {
                    id raw = attribute(element, kAXURLAttribute);
                    url = urlText(raw, kMaxElementUrl);
                    if (webArea && !documentUrl) documentUrl = urlText(raw, kMaxDocumentUrl);
                }
                if (label || value || url || subrole || secure || !isLayoutRole(role)) {
                    NSMutableDictionary *item = [@{ @"role": role, @"label": label ?: @"", @"frame": frameObject(bounds),
                        @"secure": @(secure), @"enabled": @(enabled), @"depth": @(entry.depth) } mutableCopy];
                    NSMutableArray *path = [NSMutableArray arrayWithCapacity:entry.path.size()];
                    for (uint32_t index : entry.path) [path addObject:@(index)];
                    item[@"path"] = path;
                    if (subrole) item[@"subrole"] = subrole;
                    if (value) item[@"value"] = value;
                    if (url) item[@"url"] = url;
                    if (focused && focusedIndex < 0 && CFEqual((__bridge CFTypeRef)focused, element))
                        focusedIndex = static_cast<NSInteger>(elements.count);
                    [elements addObject:item];
                    emitted = true;
                }
            }

            NSArray *children = present(base[4]);
            if (![children isKindOfClass:NSArray.class] || entry.path.size() >= kMaxPath) continue;
            const size_t queued = visited + pending.size();
            const size_t remaining = queued < kMaxNodes ? kMaxNodes - queued : 0;
            const NSUInteger take = std::min<size_t>(std::min<size_t>(children.count, remaining), kMaxChildIndex + 1);
            const int childDepth = entry.depth + (emitted ? 1 : 0);
            // Reverse push so the stack pops children in document order.
            for (NSUInteger index = take; index-- > 0;) {
                id child = children[index];
                if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
                std::vector<uint32_t> path = entry.path;
                path.push_back(static_cast<uint32_t>(index));
                pending.push_back({child, childDepth, false, std::move(path)});
            }
        }

        NSMutableDictionary *snapshot = [@{
            @"app": @{ @"bundleId": scan.bundleId, @"name": scan.name, @"pid": @(scan.pid) },
            @"window": @{ @"title": text(attribute(windowRef, kAXTitleAttribute), kMaxTitle) ?: @"",
                          @"frame": frameObject(windowFrame) },
            @"elements": elements } mutableCopy];
        if (documentUrl) snapshot[@"url"] = documentUrl;
        if (focusedIndex >= 0) snapshot[@"focusedElementIndex"] = @(focusedIndex);
        @try { scan.result = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil]; }
        @catch (NSException *) { scan.result = nil; }
    }
}

void complete(napi_env env, napi_status status, void *data) {
    auto *scan = static_cast<Scan *>(data);
    napi_value result;
    // The user may have switched apps mid-walk; a snapshot of the old app would be misleading.
    NSData *bytes = status == napi_ok && frontPid() == scan->pid ? scan->result : nil;
    napi_create_string_utf8(env, bytes ? static_cast<const char *>(bytes.bytes) : kEmpty,
                           bytes ? bytes.length : sizeof(kEmpty) - 1, &result);
    napi_resolve_deferred(env, scan->deferred, result);
    napi_delete_async_work(env, scan->work);
    delete scan;
}

napi_value snapshot(napi_env env, napi_callback_info) {
    const pid_t target = frontPid();
    NSRunningApplication *front = target > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:target] : nil;
    napi_value result;
    if (!front || front.processIdentifier <= 0) {
        napi_create_string_utf8(env, kEmpty, sizeof(kEmpty) - 1, &result);
        return result;
    }
    auto *scan = new Scan;
    scan->pid = front.processIdentifier;
    scan->bundleId = text(front.bundleIdentifier, 255) ?: @"";
    scan->name = text(front.localizedName, 255) ?: @"";
    napi_value name;
    napi_status status = napi_create_promise(env, &scan->deferred, &result);
    if (status == napi_ok) status = napi_create_string_utf8(env, "Triage context snapshot", NAPI_AUTO_LENGTH, &name);
    if (status == napi_ok) status = napi_create_async_work(env, nullptr, name, collect, complete, scan, &scan->work);
    if (status == napi_ok) status = napi_queue_async_work(env, scan->work);
    if (status != napi_ok) {
        if (scan->work) napi_delete_async_work(env, scan->work);
        delete scan;
        napi_throw_error(env, nullptr, "Could not schedule context snapshot");
        return nullptr;
    }
    return result;
}

// ---------------------------------------------------------------------------
// frameOf(pid, path): where is a previously snapshotted element now? Reads only
// role, position and size - never a label or a value.
// ---------------------------------------------------------------------------

struct Probe {
    pid_t pid = 0;
    std::vector<uint32_t> path;
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    NSString *role = nil;
    CGRect frame = CGRectNull;
};

void locate(napi_env, void *data) {
    @autoreleasepool {
        auto &probe = *static_cast<Probe *>(data);
        id app = CFBridgingRelease(AXUIElementCreateApplication(probe.pid));
        auto appRef = (__bridge AXUIElementRef)app;
        AXUIElementSetMessagingTimeout(appRef, 0.05);
        id current = focusedWindow(appRef);
        if (!current) return;
        auto windowRef = (__bridge AXUIElementRef)current;
        const CGRect windowFrame = rect(attribute(windowRef, kAXPositionAttribute), attribute(windowRef, kAXSizeAttribute));
        if (CGRectIsNull(windowFrame) || CGRectIsEmpty(windowFrame)) return;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(120);
        for (uint32_t index : probe.path) {
            if (std::chrono::steady_clock::now() >= deadline) return;
            CFArrayRef raw = nullptr;
            // Fetch exactly one child per level instead of every sibling.
            if (AXUIElementCopyAttributeValues((__bridge AXUIElementRef)current, kAXChildrenAttribute, index, 1, &raw) != kAXErrorSuccess) return;
            NSArray *child = CFBridgingRelease(raw);
            if (child.count != 1 || CFGetTypeID((__bridge CFTypeRef)child[0]) != AXUIElementGetTypeID()) return;
            current = child[0];
        }
        auto element = (__bridge AXUIElementRef)current;
        NSArray *values = attributes(element, @[ (__bridge NSString *)kAXRoleAttribute,
            (__bridge NSString *)kAXPositionAttribute, (__bridge NSString *)kAXSizeAttribute ]);
        if (!values) return;
        NSString *role = present(values[0]);
        const CGRect bounds = rect(present(values[1]), present(values[2]));
        if (![role isKindOfClass:NSString.class] || !role.length || role.length > 80 || CGRectIsNull(bounds) ||
            CGRectIsEmpty(bounds) || !CGRectIntersectsRect(windowFrame, bounds)) return;
        probe.role = role;
        probe.frame = bounds;
    }
}

void located(napi_env env, napi_status status, void *data) {
    auto *probe = static_cast<Probe *>(data);
    NSMutableDictionary *reply = [@{ @"frontmost": @(frontPid() == probe->pid), @"frame": NSNull.null } mutableCopy];
    if (status == napi_ok && probe->role) {
        reply[@"role"] = probe->role;
        reply[@"frame"] = frameObject(probe->frame);
    }
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:reply options:0 error:nil];
    napi_value result;
    napi_create_string_utf8(env, static_cast<const char *>(bytes.bytes), bytes.length, &result);
    napi_resolve_deferred(env, probe->deferred, result);
    napi_delete_async_work(env, probe->work);
    delete probe;
}

napi_value frameOf(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value arguments[2];
    int32_t pid = 0;
    uint32_t length = 0;
    bool isArray = false;
    if (napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr) != napi_ok || count < 2 ||
        napi_get_value_int32(env, arguments[0], &pid) != napi_ok || pid <= 0 ||
        napi_is_array(env, arguments[1], &isArray) != napi_ok || !isArray ||
        napi_get_array_length(env, arguments[1], &length) != napi_ok || length > kMaxPath) {
        napi_throw_type_error(env, nullptr, "frameOf(pid, path) needs a process id and a child-index path");
        return nullptr;
    }
    auto *probe = new Probe;
    probe->pid = pid;
    for (uint32_t position = 0; position < length; position++) {
        napi_value item;
        uint32_t index = 0;
        if (napi_get_element(env, arguments[1], position, &item) != napi_ok ||
            napi_get_value_uint32(env, item, &index) != napi_ok || index > kMaxChildIndex) {
            delete probe;
            napi_throw_type_error(env, nullptr, "frameOf path entries must be small non-negative integers");
            return nullptr;
        }
        probe->path.push_back(index);
    }
    napi_value result;
    napi_value name;
    napi_status status = napi_create_promise(env, &probe->deferred, &result);
    if (status == napi_ok) status = napi_create_string_utf8(env, "Triage element frame", NAPI_AUTO_LENGTH, &name);
    if (status == napi_ok) status = napi_create_async_work(env, nullptr, name, locate, located, probe, &probe->work);
    if (status == napi_ok) status = napi_queue_async_work(env, probe->work);
    if (status != napi_ok) {
        if (probe->work) napi_delete_async_work(env, probe->work);
        delete probe;
        napi_throw_error(env, nullptr, "Could not schedule element frame lookup");
        return nullptr;
    }
    return result;
}

// Lets the caller tell "no permission" apart from "nothing on screen".
napi_value accessibilityTrusted(napi_env env, napi_callback_info) {
    napi_value result;
    napi_get_boolean(env, AXIsProcessTrusted(), &result);
    return result;
}

napi_value initialize(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, nullptr, &function);
    napi_set_named_property(env, exports, "snapshot", function);
    napi_create_function(env, "frameOf", NAPI_AUTO_LENGTH, frameOf, nullptr, &function);
    napi_set_named_property(env, exports, "frameOf", function);
    napi_create_function(env, "accessibilityTrusted", NAPI_AUTO_LENGTH, accessibilityTrusted, nullptr, &function);
    napi_set_named_property(env, exports, "accessibilityTrusted", function);
    return exports;
}
}

NAPI_MODULE(triage_context_snapshot, initialize)
