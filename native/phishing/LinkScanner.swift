import AppKit
import ApplicationServices

struct Link: Encodable {
    let url: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func geometry<T>(_ element: AXUIElement, _ name: String, _ type: AXValueType, _ value: inout T) -> Bool {
    guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return false }
    return withUnsafeMutablePointer(to: &value) { AXValueGetValue(raw as! AXValue, type, $0) }
}

func frame(_ element: AXUIElement) -> CGRect? {
    var point = CGPoint.zero
    var size = CGSize.zero
    guard geometry(element, kAXPositionAttribute, .cgPoint, &point),
          geometry(element, kAXSizeAttribute, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func scan() -> [Link] {
    guard let front = NSWorkspace.shared.frontmostApplication,
          front.bundleIdentifier == "com.google.Chrome" else { return [] }
    let browser = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(browser, 0.2)
    guard let raw = attribute(browser, kAXFocusedWindowAttribute),
          CFGetTypeID(raw) == AXUIElementGetTypeID() else { return [] }

    var pending: [(AXUIElement, CGRect?)] = [(raw as! AXUIElement, nil)]
    var links: [Link] = []
    var visited = 0
    while let (element, viewport) = pending.popLast(), visited < 1500, links.count < 250 {
        visited += 1
        let role = attribute(element, kAXRoleAttribute) as? String
        let visible = role == "AXWebArea" ? frame(element) : viewport
        if role == "AXLink", let visible, let bounds = frame(element),
           visible.contains(bounds), !bounds.isEmpty,
           let url = attribute(element, kAXURLAttribute) as? URL, url.absoluteString.utf8.count <= 2048 {
            links.append(Link(url: url.absoluteString, x: bounds.minX, y: bounds.minY,
                              width: bounds.width, height: bounds.height))
        }
        let remaining = 1500 - visited - pending.count
        guard remaining > 0 else { continue }
        var rawChildren: CFArray?
        if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, remaining, &rawChildren) == .success,
           let children = rawChildren as? [AXUIElement] {
            pending.append(contentsOf: children.reversed().map { ($0, visible) })
        }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == front.processIdentifier else { return [] }
    return links
}

let prompt = CommandLine.arguments.contains("--request-access")
let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
guard AXIsProcessTrustedWithOptions(options) else { exit(2) }
if prompt { exit(0) }
let data = try JSONEncoder().encode(scan())
FileHandle.standardOutput.write(data)
