// Local-only speech worker. Audio and provisional text never enter files or logs.
import AppKit
import AVFoundation
import Speech
import CoreAudio
import AudioToolbox
import Darwin
import Carbon
import ApplicationServices

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let maxFrame = 65536
var socketFD: Int32 = -1
var readSource: DispatchSourceRead?
var heartbeat: Timer?
var deadline: Timer?
var buffer = Data()
var generation = ""
var incoming = 0
var outgoing = 0
var authenticated = false
var lastHeartbeat = ProcessInfo.processInfo.systemUptime
let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
var engine: AVAudioEngine?
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var session: String?
var finishing = false
var permissionsPending = false
var permissionEpoch = 0
var lastPartial = 0.0
var latestText = ""

// Audio callback owns at most one converted 16 kHz buffer, never a spool/retained recording.
final class AudioGate {
    let lock = NSLock()
    var active = true
    var frames = 0
    var lastLevel = 0.0
    var levelPending = false
}
// Coalesce recognition callbacks before scheduling main work: at most one bounded text slot.
final class SpeechMailbox {
    let lock = NSLock()
    var scheduled = false
    var text = ""
    var final = false
    var failure: String?
    func store(_ result: SFSpeechRecognitionResult?, _ error: Error?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let result {
            let candidate = result.bestTranscription.formattedString
            if candidate.utf16.count > 12000 { failure = "overflow" }
            else { text = candidate; final = final || result.isFinal }
        } else if error != nil { failure = "recognition" }
        if scheduled { return false }
        scheduled = true
        return true
    }
    func take() -> (String, Bool, String?) {
        lock.lock(); defer { lock.unlock() }
        scheduled = false
        return (text, final, failure)
    }
}
var audioGate: AudioGate?
func closeAudio() {
    if let gate = audioGate { gate.lock.lock(); gate.active = false; gate.lock.unlock() }
    if let engine { engine.stop(); engine.inputNode.removeTap(onBus: 0); engine.reset() }
    engine = nil
    audioGate = nil
}
func cleanup() {
    deadline?.invalidate(); deadline = nil
    closeAudio()
    request?.endAudio(); task?.cancel()
    request = nil; task = nil; session = nil; finishing = false; latestText = ""
}
func quit() -> Never {
    cleanup()
    if socketFD >= 0 { Darwin.close(socketFD) }
    exit(0)
}
func emit(_ type: String, _ fields: [String: Any] = [:]) {
    outgoing += 1
    var object: [String: Any] = ["v": 1, "generation": generation, "seq": outgoing, "type": type]
    fields.forEach { object[$0.key] = $0.value }
    guard var data = try? JSONSerialization.data(withJSONObject: object), data.count <= maxFrame else { quit() }
    data.append(10)
    let sent = data.withUnsafeBytes { Darwin.send(socketFD, $0.baseAddress!, data.count, 0) }
    // Backpressure fails closed rather than blocking the control queue or growing buffers.
    if sent != data.count { quit() }
}
func fail(_ reason: String) {
    let id = session
    cleanup(); armHeartbeat()
    emit("failed", id.map { ["reason": reason, "sessionId": $0] } ?? ["reason": reason])
}
func property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return "" }
    return value as String
}
func devices() -> [(AudioDeviceID, String, String)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr, size <= 65536 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var input = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var bytes: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &input, 0, nil, &bytes) == noErr, bytes > 0 else { return nil }
        let uid = property(id, kAudioDevicePropertyDeviceUID)
        let label = property(id, kAudioObjectPropertyName)
        guard !uid.isEmpty, uid.utf8.count <= 256 else { return nil }
        return (id, uid, String((label.isEmpty ? "Microphone" : label).prefix(128)))
    }.prefix(64).map { $0 }
}
func permission(_ status: AVAuthorizationStatus) -> String {
    status == .authorized ? "authorized" : status == .notDetermined ? "not-determined" : "denied"
}
func availability() {
    let speech = SFSpeechRecognizer.authorizationStatus()
    emit("availability", ["availability": [
        "microphone": permission(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speech": speech == .authorized ? "authorized" : speech == .notDetermined ? "not-determined" : "denied",
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "available": recognizer?.isAvailable ?? false,
        "devices": devices().map { ["id": $0.1, "label": $0.2] }
    ]])
}
func armHeartbeat() {
    heartbeat?.invalidate()
    let limit = session == nil ? 11.0 : 2.25
    let remaining = max(0.001, limit - (ProcessInfo.processInfo.systemUptime - lastHeartbeat))
    heartbeat = Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) { _ in quit() }
}
func start(_ id: String, _ uid: String?) {
    guard session == nil, !permissionsPending else { fail("audio"); return }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
          SFSpeechRecognizer.authorizationStatus() == .authorized else { fail("permission"); return }
    guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { fail("unavailable"); return }
    session = id
    finishing = false
    latestText = ""; lastPartial = 0
    let currentDevices = devices()
    guard !currentDevices.isEmpty else { fail("device"); return }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    if let uid {
        guard let selected = currentDevices.first(where: { $0.1 == uid }), let unit = input.audioUnit else { fail("device"); return }
        var device = selected.0
        guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else { fail("device"); return }
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate.isFinite, format.sampleRate >= 8000, format.sampleRate <= 192000,
          format.channelCount > 0, format.channelCount <= 32,
          let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: format, to: target) else { fail("device"); return }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    selfAssign(engine, request)
    let gate = AudioGate()
    audioGate = gate
    let mailbox = SpeechMailbox()
    task = recognizer.recognitionTask(with: request) { result, error in
        guard mailbox.store(result, error) else { return }
        DispatchQueue.main.async {
            let (text, final, failure) = mailbox.take()
            guard session == id else { return }
            latestText = text
            if final && failure != "overflow" {
                if !finishing { fail("recognition"); return }
                cleanup(); armHeartbeat()
                emit("final", ["sessionId": id, "text": text])
            } else if let failure { fail(failure) }
            else {
                let now = ProcessInfo.processInfo.systemUptime
                if now - lastPartial >= 0.2 {
                    lastPartial = now
                    emit("partial", ["sessionId": id, "text": text])
                }
            }
        }
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { pcm, _ in
        gate.lock.lock()
        defer { gate.lock.unlock() }
        guard gate.active else { return }
        let capacity = UInt32(ceil(Double(pcm.frameLength) * 16000 / format.sampleRate)) + 32
        guard capacity <= 16000, let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            gate.active = false; DispatchQueue.main.async { if session == id { fail("overflow") } }; return
        }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: converted, error: &conversionError) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true; state.pointee = .haveData; return pcm
        }
        guard status != .error, conversionError == nil else {
            gate.active = false; DispatchQueue.main.async { if session == id { fail("audio") } }; return
        }
        gate.frames += Int(converted.frameLength)
        guard gate.frames <= 720000 else {
            gate.active = false; DispatchQueue.main.async { if session == id { fail("overflow") } }; return
        }
        request.append(converted)
        let now = ProcessInfo.processInfo.systemUptime
        if now - gate.lastLevel >= 0.2 && !gate.levelPending {
            gate.lastLevel = now
            gate.levelPending = true
            let samples = converted.floatChannelData?[0]
            var peak: Float = 0
            if let samples { for i in 0..<Int(converted.frameLength) { peak = max(peak, abs(samples[i])) } }
            let level = peak.isFinite ? Double(min(1, peak)) : 0
            DispatchQueue.main.async {
                gate.lock.lock(); gate.levelPending = false; gate.lock.unlock()
                if session == id && !finishing { emit("level", ["sessionId": id, "level": level]) }
            }
        }
    }
    do {
        try engine.start()
        emit("started", ["sessionId": id])
        deadline = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { _ in if session == id { fail("timeout") } }
        armHeartbeat()
    } catch { fail("audio") }
}
// Assign globals without shadowing them in the start function.
func selfAssign(_ value: AVAudioEngine, _ speech: SFSpeechAudioBufferRecognitionRequest) { engine = value; request = speech }
// Exclusive Carbon activation consumes the chord; the passive tap observes only
// releases/rearming. Unrelated keys are never retained or sent to the parent.
final class TalkShortcut {
    var binding: EventHotKeyRef?
    var handler: EventHandlerRef?
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var reconcile: Timer?
    var key: CGKeyCode = 49
    var modifiers: [(UInt32, CGEventFlags, [CGKeyCode])] = []
    var chord: String?
    var hold: String?
    var armed = false
    let modifierMap: [String: (UInt32, CGEventFlags, [CGKeyCode])] = [
        "Control": (UInt32(controlKey), .maskControl, [59, 62]),
        "Option": (UInt32(optionKey), .maskAlternate, [58, 61]),
        "Shift": (UInt32(shiftKey), .maskShift, [56, 60]),
        "Command": (UInt32(cmdKey), .maskCommand, [55, 54])]
    let keys: [String: CGKeyCode] = ["Space":49,"A":0,"B":11,"C":8,"D":2,"E":14,"F":3,"G":5,"H":4,"I":34,"J":38,"K":40,"L":37,"M":46,"N":45,"O":31,"P":35,"Q":12,"R":15,"S":1,"T":17,"U":32,"V":9,"W":13,"X":7,"Y":16,"Z":6,"0":29,"1":18,"2":19,"3":20,"4":21,"5":23,"6":22,"7":26,"8":28,"9":25]
    func down(_ code: CGKeyCode) -> Bool { CGEventSource.keyState(.combinedSessionState, key: code) }
    func allUp() -> Bool { !down(key) && modifiers.allSatisfy { !$0.2.contains(where: down) } }
    func chordDown() -> Bool { down(key) && modifiers.allSatisfy { $0.2.contains(where: down) } }
    func state(_ id: String, _ status: String, _ notice: String) {
        emit("shortcut", ["operationId": id, "status": status, "chord": chord as Any? ?? NSNull(), "notice": notice])
    }
    func register(_ candidate: String, _ id: String, _ prompt: Bool) {
        let parts = candidate.components(separatedBy: "+")
        guard parts.count >= 2, parts.count <= 5, Set(parts).count == parts.count,
              let candidateKey = keys[parts.last!], parts.dropLast().allSatisfy({ modifierMap[$0] != nil }) else { quit() }
        if !CGPreflightListenEventAccess() {
            if prompt { _ = CGRequestListenEventAccess() }
            invalidate("Input Monitoring is required for global talk. Enable Triage Voice Helper in System Settings → Privacy & Security → Input Monitoring, then retry setup. Click-to-talk remains available.")
            state(id, "denied", "Allow Input Monitoring for Triage Voice Helper, then retry setup. Click-to-talk remains available."); return
        }
        if chord == candidate, binding != nil, tap != nil {
            state(id, "registered", "Global talk registered. Release all chord keys before a fresh press."); return
        }
        let candidateModifiers = parts.dropLast().map { modifierMap[$0]! }
        var replacement: EventHotKeyRef?
        let result = RegisterEventHotKey(UInt32(candidateKey), candidateModifiers.reduce(0) { $0 | $1.0 },
            EventHotKeyID(signature: 0x54525631, id: 1), GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &replacement)
        guard result == noErr, let replacement else {
            state(id, "conflict", "That shortcut could not be registered. Choose another chord; the previous binding is unchanged."); return
        }
        if tap == nil {
            let mask = (CGEventMask(1) << CGEventType.keyUp.rawValue) | (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
            tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                eventsOfInterest: mask, callback: { _, type, event, context in
                    let owner = Unmanaged<TalkShortcut>.fromOpaque(context!).takeUnretainedValue()
                    owner.observe(type, event)
                    return Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque())
            guard let tap else { UnregisterEventHotKey(replacement); state(id, "unavailable", "Release watcher unavailable. Retry setup; click-to-talk remains available."); return }
            source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
                Unmanaged<TalkShortcut>.fromOpaque(context!).takeUnretainedValue().press()
                return noErr
            }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler)
            if installed != noErr {
                UnregisterEventHotKey(replacement); invalidate("Global activation unavailable. Retry setup.")
                state(id, "unavailable", "Global activation unavailable. Click-to-talk remains available."); return
            }
        }
        // Only replace the existing binding after both registration and watcher succeed.
        end("reconfigured", cancelled: true)
        if let binding { UnregisterEventHotKey(binding) }
        binding = replacement; key = candidateKey; modifiers = candidateModifiers; chord = candidate
        armed = allUp()
        state(id, "registered", "Global talk registered. Hold \(candidate), wait for Listening, then release to send.")
    }
    func press() {
        guard binding != nil, armed, hold == nil else { return }
        guard CGPreflightListenEventAccess(), let tap, CGEvent.tapIsEnabled(tap: tap) else {
            invalidate("Global release watcher lost permission. Retry setup; click-to-talk remains available."); return
        }
        armed = false
        let id = UUID().uuidString
        hold = id
        emit("pressed", ["holdId": id])
        // Watcher is already installed; reconcile immediately after activation.
        if !chordDown() { end("startup", cancelled: true); return }
        let began = ProcessInfo.processInfo.systemUptime
        reconcile = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard CGPreflightListenEventAccess(), let tap = self.tap, CGEvent.tapIsEnabled(tap: tap) else {
                self.invalidate("Global release watcher lost permission. Retry setup."); return
            }
            if !self.chordDown() { self.end("missed-release", cancelled: true) }
            else if ProcessInfo.processInfo.systemUptime - began >= 45 { self.end("watchdog", cancelled: true) }
        }
    }
    func observe(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            invalidate("Global release watcher interrupted. Retry setup; click-to-talk remains available."); return
        }
        if type == .keyUp && event.getIntegerValueField(.keyboardEventKeycode) == Int64(key) {
            end("key-up", cancelled: false)
        } else if type == .flagsChanged && modifiers.contains(where: { !event.flags.contains($0.1) }) {
            end("modifier-up", cancelled: false)
        }
        // Event callbacks can precede CGEventSource updates. Rearm later, and only
        // after every required key is up, including left/right modifier variants.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.hold == nil else { return }
            if self.allUp() { self.armed = true }
        }
    }
    func end(_ reason: String, cancelled: Bool) {
        reconcile?.invalidate(); reconcile = nil
        guard let id = hold else { return }
        hold = nil; armed = false
        emit("released", ["holdId": id, "reason": reason, "cancelled": cancelled])
    }
    func invalidate(_ notice: String) {
        end("invalidated", cancelled: true)
        if let binding { UnregisterEventHotKey(binding) }; binding = nil
        if let handler { RemoveEventHandler(handler) }; handler = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }; tap = nil
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }; source = nil
        chord = nil; armed = false
        emit("shortcut-invalidated", ["notice": notice])
    }
    func checkPermission() {
        if binding != nil && !CGPreflightListenEventAccess() { invalidate("Input Monitoring was revoked. Retry setup; click-to-talk remains available.") }
    }
}
let talkShortcut = TalkShortcut()

func command(_ object: [String: Any]) {
    guard object["v"] as? Int == 1, let type = object["type"] as? String,
          let seq = object["seq"] as? Int, seq == incoming + 1,
          let gen = object["generation"] as? String, UUID(uuidString: gen) != nil else { quit() }
    incoming = seq
    let common: Set<String> = ["v", "type", "seq", "generation"]
    let extra: Set<String>
    switch type {
    case "shortcut-register": extra = ["operationId", "chord", "prompt"]
    case "hello": extra = ["nonce"]
    case "start": extra = ["sessionId", "microphoneId"]
    case "finish", "cancel": extra = ["sessionId"]
    case "initialize", "permissions", "ping", "shutdown": extra = []
    default: quit()
    }
    guard Set(object.keys).isSubset(of: common.union(extra)) else { quit() }
    if !authenticated {
        guard type == "hello", let nonce = object["nonce"] as? String, UUID(uuidString: nonce) != nil else { quit() }
        generation = gen; authenticated = true
        emit("hello", ["nonce": nonce, "pid": ProcessInfo.processInfo.processIdentifier])
        armHeartbeat(); return
    }
    guard gen == generation, type != "hello" else { quit() }
    lastHeartbeat = ProcessInfo.processInfo.systemUptime
    if session != nil && (AVCaptureDevice.authorizationStatus(for: .audio) != .authorized || SFSpeechRecognizer.authorizationStatus() != .authorized) { fail("permission") }
    armHeartbeat()
    switch type {
    case "shortcut-register":
        guard let id = object["operationId"] as? String, UUID(uuidString: id) != nil,
              let chord = object["chord"] as? String, let prompt = object["prompt"] as? Bool else { quit() }
        talkShortcut.register(chord, id, prompt)
    case "initialize": availability()
    case "permissions":
        guard session == nil, !permissionsPending else { quit() }
        permissionsPending = true
        let epoch = permissionEpoch
        SFSpeechRecognizer.requestAuthorization { _ in
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    guard epoch == permissionEpoch else { return }
                    permissionsPending = false; availability()
                }
            }
        }
    case "start", "finish", "cancel":
        guard let id = object["sessionId"] as? String, UUID(uuidString: id) != nil else { quit() }
        if type == "start" {
            guard object["microphoneId"] == nil || object["microphoneId"] is String else { quit() }
            start(id, object["microphoneId"] as? String)
        } else if session == id {
            if type == "cancel" { cleanup(); armHeartbeat(); emit("stopped", ["sessionId": id]) }
            else if !finishing {
                finishing = true; deadline?.invalidate()
                closeAudio(); request?.endAudio()
                deadline = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { _ in if session == id { fail("timeout") } }
            }
        }
    case "ping": talkShortcut.checkPermission(); emit("pong")
    case "shutdown": quit()
    default: quit()
    }
}

// Launch Services passes only a main-generated private socket path, never renderer data.
guard CommandLine.arguments.count == 2 else { exit(1) }
let path = CommandLine.arguments[1]
guard path.utf8.count < 104 else { exit(1) }
socketFD = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
guard socketFD >= 0 else { exit(1) }
var noSigPipe: Int32 = 1
setsockopt(socketFD, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
withUnsafeMutableBytes(of: &address.sun_path) { target in
    target.copyBytes(from: Array(path.utf8) + [0])
}
let connected = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard connected == 0 else { quit() }
_ = fcntl(socketFD, F_SETFL, O_NONBLOCK)
readSource = DispatchSource.makeReadSource(fileDescriptor: socketFD, queue: .main)
readSource?.setEventHandler {
    var bytes = [UInt8](repeating: 0, count: 8192)
    let count = Darwin.read(socketFD, &bytes, bytes.count)
    if count == 0 { quit() }
    if count < 0 { if errno != EAGAIN { quit() }; return }
    buffer.append(contentsOf: bytes.prefix(count))
    var frames = 0
    while let end = buffer.firstIndex(of: 10) {
        frames += 1
        guard frames <= 32, end <= maxFrame,
              let object = try? JSONSerialization.jsonObject(with: buffer.prefix(end)) as? [String: Any] else { quit() }
        buffer.removeSubrange(...end)
        command(object)
    }
    if buffer.count > maxFrame { quit() }
}
readSource?.resume()
DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if !authenticated { quit() } }
let notifications = NSWorkspace.shared.notificationCenter
notifications.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in quit() }
DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in quit() }
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { notification in
    if let current = engine, let changed = notification.object as? AVAudioEngine, current === changed, session != nil { fail("device") }
}
app.run()
quit()
