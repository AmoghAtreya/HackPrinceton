// Isolated Phase 8 probe. No assistant, history, network client, or audio files.
import AppKit
import AVFoundation
import Speech
import Carbon
import ApplicationServices

var probeLabel: NSTextField?
func showStatus(_ text: String) -> NSPanel {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 160),
        styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.title = "Triage Voice Probe — isolated Phase 8 check"
    panel.level = .floating
    panel.isReleasedWhenClosed = false
    panel.ignoresMouseEvents = true
    let label = NSTextField(wrappingLabelWithString: text)
    label.frame = NSRect(x: 20, y: 20, width: 520, height: 120)
    label.font = .systemFont(ofSize: 16)
    panel.contentView?.addSubview(label)
    probeLabel = label
    panel.center()
    panel.orderFrontRegardless()
    return panel
}

func report(_ values: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
    if values["probe"] as? String == "activation" {
        probeLabel?.stringValue = "Detected press. Release Space or either modifier.\nThen repeat from another app. No assistant task is sent."
    } else if values["probe"] as? String == "release" {
        probeLabel?.stringValue = "Detected release: \(values["reason"] ?? "").\nTry another hold, including releasing Option first."
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
let engine = AVAudioEngine()
let synth = AVSpeechSynthesizer()
report([
    "probe": "capabilities", "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "speechAuthorization": SFSpeechRecognizer.authorizationStatus().rawValue,
    "microphoneAuthorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
    "recognizerAvailable": recognizer?.isAvailable ?? false,
    "onDeviceRecognition": recognizer?.supportsOnDeviceRecognition ?? false,
    "englishOutputVoice": AVSpeechSynthesisVoice(language: "en-US") != nil,
    "inputMonitoring": CGPreflightListenEventAccess(),
    "accessibility": AXIsProcessTrusted(), "engineRunning": engine.isRunning
])

var holding = false
var activations = 0
var releases = 0
var activationApp: pid_t = 0
func chordDown() -> Bool {
    let control = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_Control)) || CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_RightControl))
    let option = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_Option)) || CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_RightOption))
    return control && option && CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_Space))
}
func releaseHold(_ reason: String) {
    guard holding else { return }
    holding = false
    releases += 1
    report(["probe": "release", "reason": reason, "chordStillDown": chordDown(),
            "foregroundChangedDuringHold": activationApp != (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)])
}

let mode = CommandLine.arguments.dropFirst().first ?? "inspect"
if mode == "inspect" { exit(0) }

if mode == "idle" {
    let cpuStart = clock()
    let started = ProcessInfo.processInfo.systemUptime
    RunLoop.main.run(until: Date().addingTimeInterval(10))
    let wall = ProcessInfo.processInfo.systemUptime - started
    let cpu = Double(clock() - cpuStart) / Double(CLOCKS_PER_SEC)
    report(["probe": "idle", "wallSeconds": wall, "cpuSeconds": cpu,
            "cpuPercentOneCore": 100 * cpu / wall, "engineRunning": engine.isRunning])
} else if mode == "keys" {
    // A created tap may still deliver nothing when its permission is absent.
    if !CGPreflightListenEventAccess() {
        let permissionPanel = showStatus("Enable Triage Voice Probe in System Settings → Privacy & Security → Input Monitoring.\nThis check waits up to 45 seconds. Reopen the probe if macOS requests it.")
        _ = CGRequestListenEventAccess()
        let deadline = Date().addingTimeInterval(45)
        while !CGPreflightListenEventAccess() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        }
        permissionPanel.close()
        guard CGPreflightListenEventAccess() else {
            report(["probe": "inputMonitoringRequired"])
            exit(2)
        }
    }
    // Carbon owns activation/conflict detection; a passive session tap sees release.
    // Never emit key codes, characters, window titles, or unrelated key events.
    var hotkey: EventHotKeyRef?
    let id = EventHotKeyID(signature: 0x54524938, id: 1)
    let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), id,
                                    GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &hotkey)
    var conflicting: EventHotKeyRef?
    let duplicate = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey),
                                       EventHotKeyID(signature: 0x54524938, id: 2),
                                       GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &conflicting)
    if let conflicting { UnregisterEventHotKey(conflicting) }
    report(["probe": "registration", "status": status, "duplicateStatus": duplicate,
            "chord": "Control+Option+Space"])
    guard status == noErr, let hotkey else { exit(2) }
    defer { UnregisterEventHotKey(hotkey) }
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    var handler: EventHandlerRef?
    let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
        guard !holding else { return noErr }
        holding = true
        activations += 1
        activationApp = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        report(["probe": "activation", "chordCurrentlyDown": chordDown(),
                "otherAppForeground": activationApp != getpid()])
        if !chordDown() { releaseHold("startupReconciliation") }
        if CommandLine.arguments.contains("--switch-focus") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard holding else { return }
                // Test-only foreground change while real physical keys stay held.
                // No synthetic key events, Accessibility access or general input log.
                NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.activate(options: [])
            }
        }
        return noErr
    }, 1, &eventType, nil, &handler)
    guard installed == noErr else { exit(2) }
    defer { if let handler { RemoveEventHandler(handler) } }
    let mask = (CGEventMask(1) << CGEventType.keyUp.rawValue) | (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
        options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, _ in
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                releaseHold("watcherInvalidated")
                report(["probe": "releaseWatcherInvalidated"])
            } else if type == .keyUp && event.getIntegerValueField(.keyboardEventKeycode) == Int64(kVK_Space) {
                releaseHold("spaceUp")
            } else if type == .flagsChanged && (!event.flags.contains(.maskControl) || !event.flags.contains(.maskAlternate)) {
                releaseHold("modifierUp")
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: nil) else {
        report(["probe": "releaseWatcherUnavailable", "inputMonitoring": CGPreflightListenEventAccess()])
        exit(2)
    }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)!
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    let panel = showStatus("Shortcut check: 45 seconds\nFrom another app, hold Control (⌃) + Option (⌥) + Space, then release. Try releasing Option first too.\nThis panel does not take keyboard focus.")
    defer { panel.close() }
    report(["probe": "watching", "seconds": 45])
    let timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { _ in
        app.stop(nil)
        if let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
            subtype: 0, data1: 0, data2: 0) { app.postEvent(event, atStart: false) }
    }
    app.run()
    timer.invalidate()
    CGEvent.tapEnable(tap: tap, enable: false)
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    CFMachPortInvalidate(tap)
    releaseHold("probeShutdown")
    report(["probe": "keysFinished", "activations": activations, "releases": releases])
    if activations == 0 { exit(2) }
} else if mode == "microphone" {
    // Only this explicit mode prompts or opens a microphone. No transcript is printed.
    let panel = showStatus("Microphone check: allow the macOS speech and microphone prompts if shown.\nCapture starts only after approval. No audio or transcript is saved.")
    defer { panel.close() }
    var speech: SFSpeechRecognizerAuthorizationStatus = .notDetermined
    var mic = false
    var authorized = false
    SFSpeechRecognizer.requestAuthorization { status in
        speech = status
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async { mic = granted; authorized = true }
        }
    }
    let deadline = Date().addingTimeInterval(45)
    while !authorized && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    guard authorized, mic, speech == .authorized, let recognizer,
          recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
        report(["probe": "captureUnavailable", "authorized": authorized, "microphoneGranted": mic, "speechAuthorization": speech.rawValue])
        exit(2)
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    var final = false
    var recognized = false
    var failed = false
    var failureCode = 0
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result, result.isFinal { final = true; recognized = !result.bestTranscription.formattedString.isEmpty }
        if let error { failed = true; failureCode = (error as NSError).code }
    }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    var tapInstalled = true
    defer { engine.stop(); if tapInstalled { input.removeTap(onBus: 0) }; task.cancel() }
    do {
        probeLabel?.stringValue = "Speak after the next status change. Capture begins in 3 seconds."
        RunLoop.main.run(until: Date().addingTimeInterval(3))
        try engine.start()
        probeLabel?.stringValue = "Listening now — say: Triage voice check.\nMicrophone closes automatically after four seconds."
        report(["probe": "listening", "seconds": 4, "requiresOnDeviceRecognition": request.requiresOnDeviceRecognition])
        RunLoop.main.run(until: Date().addingTimeInterval(4))
        engine.stop()
        input.removeTap(onBus: 0)
        tapInstalled = false
        request.endAudio()
        let end = Date().addingTimeInterval(3)
        while !final && !failed && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        task.cancel()
        report(["probe": "captureStopped", "engineRunning": engine.isRunning, "final": final, "recognizedNonempty": recognized, "recognitionError": failed, "errorCode": failureCode])
    } catch {
        report(["probe": "engineStartFailed", "engineRunning": engine.isRunning])
        exit(2)
    }
} else if mode == "playback" {
    let utterance = AVSpeechUtterance(string: "Triage voice feasibility check.")
    utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
    synth.speak(utterance)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    let wasSpeaking = synth.isSpeaking
    let stopped = synth.stopSpeaking(at: .immediate)
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    report(["probe": "playbackCancelled", "wasSpeaking": wasSpeaking, "cancelAccepted": stopped, "speaking": synth.isSpeaking, "engineRunning": engine.isRunning])
} else { report(["probe": "unknownMode"]); exit(2) }
