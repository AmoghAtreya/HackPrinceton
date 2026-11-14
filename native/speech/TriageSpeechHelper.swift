// Triage on-device speech helper (free alternative to Amazon Transcribe).
//
// Launched by Triage through Launch Services as its own app bundle, so macOS
// asks for Speech Recognition permission on behalf of "Triage Speech" instead
// of whichever process started it. It never opens the microphone: Triage sends
// the 16 kHz 16-bit mono PCM it already captured over a private Unix socket.
//
// Socket protocol
//   Triage → helper: frames of [kind: 1 byte][length: 4 bytes big-endian][payload]
//     'A' audio (little-endian Int16 PCM), 'E' end of audio, 'C' cancel
//   helper → Triage: one JSON object per line
//     {"type":"ready"}
//     {"type":"result","text":"…","isFinal":false,"confidence":null}
//     {"type":"error","code":"…","message":"…"}
//     {"type":"done"}
//
// Audio and text stay in memory only; nothing is written to disk or logs.
import AVFoundation
import Foundation
import Speech

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { exit(64) }
let socketPath = arguments[1]
let language = arguments.count >= 3 ? arguments[2] : "en-US"

// A recording is at most 60 s plus finalization; never linger beyond that.
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { exit(0) }

let socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
guard socketFD >= 0 else { exit(70) }
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(socketPath.utf8)
guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else { exit(64) }
withUnsafeMutableBytes(of: &address.sun_path) { raw in
  raw.copyBytes(from: pathBytes)
  raw[pathBytes.count] = 0
}
let connected = withUnsafePointer(to: &address) { pointer in
  pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
    connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
  }
}
guard connected == 0 else { exit(69) }

let writeLock = NSLock()
func send(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
  data.append(10)
  writeLock.lock()
  defer { writeLock.unlock() }
  data.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let written = Darwin.write(socketFD, raw.baseAddress! + offset, raw.count - offset)
      if written <= 0 { exit(0) }
      offset += written
    }
  }
}

func finish() -> Never {
  send(["type": "done"])
  close(socketFD)
  exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
  send(["type": "error", "code": code, "message": message])
  close(socketFD)
  exit(0)
}

let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?

func readExactly(_ count: Int) -> [UInt8]? {
  var buffer = [UInt8](repeating: 0, count: count)
  var offset = 0
  while offset < count {
    let read = buffer.withUnsafeMutableBytes { Darwin.read(socketFD, $0.baseAddress! + offset, count - offset) }
    if read <= 0 { return nil }
    offset += read
  }
  return buffer
}

func append(_ bytes: [UInt8]) {
  let frames = bytes.count / 2
  guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
  buffer.frameLength = AVAudioFrameCount(frames)
  let channel = buffer.floatChannelData![0]
  bytes.withUnsafeBytes { raw in
    let samples = raw.bindMemory(to: Int16.self)
    for index in 0..<frames { channel[index] = Float(Int16(littleEndian: samples[index])) / 32768 }
  }
  request?.append(buffer)
}

func readLoop() {
  while true {
    guard let header = readExactly(5) else { task?.cancel(); exit(0) }
    let length = Int(header[1]) << 24 | Int(header[2]) << 16 | Int(header[3]) << 8 | Int(header[4])
    guard length <= 1 << 20 else { exit(65) }
    guard let payload = length > 0 ? readExactly(length) : [] else { task?.cancel(); exit(0) }
    switch header[0] {
    case 0x41: append(payload)           // 'A'
    case 0x45: request?.endAudio()       // 'E': keep reading until the final result is sent
    case 0x43: task?.cancel(); close(socketFD); exit(0)  // 'C'
    default: exit(65)
    }
  }
}

func start() {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
    fail("unsupported_language", "Speech recognition does not support \(language) on this Mac.")
  }
  guard recognizer.supportsOnDeviceRecognition else {
    fail("no_on_device", "On-device speech recognition is not available for \(language) on this Mac.")
  }
  guard recognizer.isAvailable else { fail("unavailable", "Speech recognition is not available right now.") }
  let newRequest = SFSpeechAudioBufferRecognitionRequest()
  newRequest.shouldReportPartialResults = true
  // Never fall back to Apple's servers: audio stays on this Mac.
  newRequest.requiresOnDeviceRecognition = true
  if #available(macOS 13, *) { newRequest.addsPunctuation = true }
  request = newRequest
  task = recognizer.recognitionTask(with: newRequest) { result, error in
    if let result {
      var confidence: Any = NSNull()
      if result.isFinal {
        let scores = result.bestTranscription.segments.map { Double($0.confidence) }.filter { $0 > 0 }
        if !scores.isEmpty { confidence = scores.reduce(0, +) / Double(scores.count) }
      }
      send(["type": "result", "text": result.bestTranscription.formattedString, "isFinal": result.isFinal, "confidence": confidence])
      if result.isFinal { finish() }
    } else if let error = error as NSError? {
      // 1110: no speech detected; 216 / 301: the request ended before any speech.
      if [1110, 216, 301].contains(error.code) {
        send(["type": "result", "text": "", "isFinal": true, "confidence": NSNull()])
        finish()
      }
      fail("recognition_failed", "Speech recognition failed (\(error.domain) \(error.code)).")
    }
  }
  send(["type": "ready"])
  Thread.detachNewThread { readLoop() }
}

switch SFSpeechRecognizer.authorizationStatus() {
case .authorized:
  start()
case .notDetermined:
  SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
      if status == .authorized { start() }
      else { fail("speech_denied", "Speech Recognition permission was not granted.") }
    }
  }
default:
  fail("speech_denied", "Speech Recognition permission was not granted.")
}
dispatchMain()
