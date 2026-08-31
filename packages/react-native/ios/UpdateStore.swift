import Foundation

/**
 <Application Support>/open-ota/
   slots/A, slots/B   extracted bundles (the `expo export` layout, preserved)
   state.json         which slot is what
   events.jsonl       events produced natively (rollbacks), drained by JS
   tmp/               in-flight downloads

 Every write is atomic: a half-written state.json read at boot would be
 indistinguishable from "no update installed" and would strand the device on the
 embedded bundle.
 */
struct OtaState: Codable {
  var currentReleaseId: String?
  var currentSlot: String?
  var currentLabel: Int?
  var previousReleaseId: String?
  var previousSlot: String?
  var previousLabel: Int?
  var pendingReleaseId: String?
  var pendingSlot: String?
  var pendingLabel: Int?
  var pendingVerification = false
  var failedReleaseIds: [String] = []
  var previewReleaseId: String?
  var deviceId: String?
  var channelOverride: String?

  init() {}

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    currentReleaseId = try values.decodeIfPresent(String.self, forKey: .currentReleaseId)
    currentSlot = try values.decodeIfPresent(String.self, forKey: .currentSlot)
    currentLabel = try values.decodeIfPresent(Int.self, forKey: .currentLabel)
    previousReleaseId = try values.decodeIfPresent(String.self, forKey: .previousReleaseId)
    previousSlot = try values.decodeIfPresent(String.self, forKey: .previousSlot)
    previousLabel = try values.decodeIfPresent(Int.self, forKey: .previousLabel)
    pendingReleaseId = try values.decodeIfPresent(String.self, forKey: .pendingReleaseId)
    pendingSlot = try values.decodeIfPresent(String.self, forKey: .pendingSlot)
    pendingLabel = try values.decodeIfPresent(Int.self, forKey: .pendingLabel)
    pendingVerification = try values.decodeIfPresent(Bool.self, forKey: .pendingVerification) ?? false
    failedReleaseIds = try values.decodeIfPresent([String].self, forKey: .failedReleaseIds) ?? []
    previewReleaseId = try values.decodeIfPresent(String.self, forKey: .previewReleaseId)
    deviceId = try values.decodeIfPresent(String.self, forKey: .deviceId)
    channelOverride = try values.decodeIfPresent(String.self, forKey: .channelOverride)
  }
}

final class UpdateStore {

  static let slotA = "A"
  static let slotB = "B"

  let directory: URL
  let tmpDirectory: URL
  private let stateURL: URL
  private let eventsURL: URL

  var state: OtaState

  init() {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    directory = base.appendingPathComponent("open-ota", isDirectory: true)
    tmpDirectory = directory.appendingPathComponent("tmp", isDirectory: true)
    stateURL = directory.appendingPathComponent("state.json")
    eventsURL = directory.appendingPathComponent("events.jsonl")

    var isDirectory: ObjCBool = false
    if !FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      var mutable = directory
      try? mutable.setResourceValues(resourceValues)
    }

    if let data = try? Data(contentsOf: stateURL),
       let decoded = try? JSONDecoder().decode(OtaState.self, from: data) {
      state = decoded
    } else {
      state = OtaState()
    }
  }

  func slotDirectory(_ slot: String) -> URL {
    directory.appendingPathComponent("slots", isDirectory: true)
      .appendingPathComponent(slot, isDirectory: true)
  }

  /// The slot not backing the running bundle. Whatever lived there is forfeit.
  func freeSlot() -> String {
    state.currentSlot == UpdateStore.slotA ? UpdateStore.slotB : UpdateStore.slotA
  }

  func write() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(state)
    try data.write(to: stateURL, options: .atomic)
  }

  /* ---------------------------------------------------------------- telemetry */

  /// Natively generated events (crash rollbacks) outlive the process that saw them.
  func appendEvent(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          var line = String(data: data, encoding: .utf8)
    else { return }
    line += "\n"

    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: eventsURL) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: Data(line.utf8))
    } else {
      try? Data(line.utf8).write(to: eventsURL, options: .atomic)
    }
  }

  // ponytail: read-then-delete, so a crash between the two loses a counter.
  // These are operational counters, not billing.
  func takeEvents() -> [[String: Any]] {
    guard let text = try? String(contentsOf: eventsURL, encoding: .utf8) else { return [] }
    try? FileManager.default.removeItem(at: eventsURL)
    return text.split(separator: "\n").compactMap { line in
      guard let data = line.data(using: .utf8) else { return nil }
      return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
  }
}

/// Typed failures; the code travels to JS as the promise rejection code.
struct OtaError: Error {
  let code: String
  let message: String

  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }

  static let notConfigured = "ERR_OTA_NOT_CONFIGURED"
  static let signatureInvalid = "ERR_OTA_SIGNATURE_INVALID"
  static let manifestMismatch = "ERR_OTA_MANIFEST_MISMATCH"
  static let downloadFailed = "ERR_OTA_DOWNLOAD_FAILED"
  static let hashMismatch = "ERR_OTA_HASH_MISMATCH"
  static let extractFailed = "ERR_OTA_EXTRACT_FAILED"
  static let nothingPending = "ERR_OTA_NOTHING_PENDING"
  static let stateWriteFailed = "ERR_OTA_STATE_WRITE_FAILED"
  static let previewInvalid = "ERR_OTA_PREVIEW_INVALID"
}
