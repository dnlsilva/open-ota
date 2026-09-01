import Foundation
import UIKit

#if canImport(React)
import React
#endif

/**
 Core of the iOS SDK, and the boot path the host app calls before any JS exists —
 from `bundleURL` / `sourceURL(for:)` in the AppDelegate or React delegate, on
 both architectures.
 */
@objc(OpenOta)
public class OpenOta: NSObject {

  static let downloadProgressEvent = "downloadProgress"
  static let updateStateEvent = "updateState"
  static let previewRequestedEvent = "previewRequested"

  private static let platform = "ios"
  private static let maxFailed = 10
  private static let maxBundleBytes = 200 * 1024 * 1024
  private static let previewClockSkewSeconds: TimeInterval = 300
  private static let bundleNames = ["main.jsbundle", "index.ios.bundle", "index.bundle"]

  static var emitter: ((String, [String: Any?]) -> Void)?

  private static let lock = NSRecursiveLock()
  private static var storeRef: UpdateStore?
  private static var configRef: OtaConfig?

  /// The crash check may only run once per process — reload() re-enters here.
  private static var bootHandled = false
  private static var previewCandidate: [String: String]?
  private static var linkObservers: [NSObjectProtocol] = []
  private static var downloader: BundleDownloader?

  /* --------------------------------------------------------------- boot path */

  /// URL of the JS bundle to run, or nil for the embedded one. Synchronous, no
  /// network: it only reads local state.
  @objc
  public static func bundleURL() -> URL? {
    lock.lock()
    defer { lock.unlock() }

    let store = self.store()
    if !bootHandled {
      bootHandled = true
      // A launch that armed pendingVerification and never called notifyAppReady
      // died before the JS could confirm itself. One strike is enough.
      if store.state.pendingVerification {
        revert(to: store.state.currentReleaseId, reason: "crash")
      }
    }

    dropReleasesBelowFloor()
    promotePending()
    // The flag has to be on disk BEFORE React Native gets the URL, otherwise a
    // crash during the very first frame looks like a clean launch next time.
    try? store.write()

    var url = resolveCurrent()
    if url == nil, store.state.currentReleaseId != nil {
      revert(to: store.state.currentReleaseId, reason: "missing")
      try? store.write()
      url = resolveCurrent()
    }
    return url
  }

  /* --------------------------------------------------------------- lifecycle */

  static func status() -> [String: Any?] {
    lock.lock()
    defer { lock.unlock() }
    let state = store().state
    let config = self.config()
    return [
      "deviceId": deviceId(),
      "channel": state.channelOverride ?? config.channel,
      "runtimeVersion": config.runtimeVersion,
      "nativeVersion": config.nativeVersion,
      "currentRelease": state.currentReleaseId.map {
        ["id": $0, "label": (state.currentLabel as Any?) ?? NSNull()]
      },
      "isPreview": state.previewReleaseId != nil,
      "pendingRelease": state.pendingReleaseId.map {
        ["id": $0, "label": (state.pendingLabel as Any?) ?? NSNull()]
      },
      "failedReleaseIds": state.failedReleaseIds,
      "embeddedFloorId": config.embeddedFloorId,
    ]
  }

  static func constants() -> [String: Any?] { config().asDictionary }

  static func downloadUpdate(
    manifestJson: String,
    signatureBase64: String,
    url: String,
    onProgress: @escaping (Int64, Int64) -> Void,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let config = self.config()
    guard config.isConfigured else {
      completion(.failure(OtaError(OtaError.notConfigured, "no projectId/publicKey baked into this binary")))
      return
    }
    guard let manifest = CanonicalJson.parse(manifestJson) as? [String: Any] else {
      completion(.failure(OtaError(OtaError.manifestMismatch, "manifest is not valid JSON")))
      return
    }

    // 1. authenticity, over our own canonical re-serialization
    guard SignatureVerifier.verify(
      canonical: CanonicalJson.canonicalize(manifest),
      signatureBase64: signatureBase64,
      publicKeyPem: config.publicKey
    ) else {
      completion(.failure(OtaError(OtaError.signatureInvalid, "manifest signature does not verify")))
      return
    }

    // 2. does this manifest even belong to this binary
    lock.lock()
    let store = self.store()
    let releaseId = manifest["id"] as? String ?? ""
    var rejection: String?
    if releaseId.isEmpty { rejection = "id" }
    else if manifest["projectId"] as? String != config.projectId { rejection = "projectId" }
    else if manifest["platform"] as? String != platform { rejection = "platform" }
    else if manifest["runtimeVersion"] as? String != config.runtimeVersion { rejection = "runtimeVersion" }
    else if store.state.failedReleaseIds.contains(releaseId) { rejection = "release already failed here" }
    // UUIDv7 sorts by time as plain text, so this rejects an OTA older than the binary.
    else if let floor = config.embeddedFloorId, releaseId <= floor { rejection = "release predates the embedded bundle" }

    let slot = store.freeSlot()
    lock.unlock()

    if let rejection {
      completion(.failure(OtaError(OtaError.manifestMismatch, "manifest \(rejection) does not match this build")))
      return
    }

    let expectedHash = (manifest["sha256"] as? String ?? "").lowercased()
    let size = (manifest["size"] as? NSNumber)?.int64Value ?? 0
    let zip = store.tmpDirectory.appendingPathComponent("\(releaseId).zip")
    guard let remote = URL(string: url) else {
      completion(.failure(OtaError(OtaError.downloadFailed, "invalid bundle url")))
      return
    }

    emit(updateStateEvent, ["state": "downloading", "releaseId": releaseId])
    downloader = BundleDownloader(
      url: remote,
      target: zip,
      expectedSize: size,
      maxBytes: Int64(maxBundleBytes),
      onProgress: onProgress
    ) { result in
      defer { try? FileManager.default.removeItem(at: zip) }
      do {
        // 3. integrity
        let digest = try result.get()
        guard digest.caseInsensitiveCompare(expectedHash) == .orderedSame else {
          throw OtaError(OtaError.hashMismatch, "sha256 \(digest) != \(expectedHash)")
        }

        // 4. install
        let slotURL = store.slotDirectory(slot)
        try Unzipper.unzip(zip, into: slotURL, maxBytes: maxBundleBytes)
        guard resolveBundle(in: slotURL) != nil else {
          throw OtaError(OtaError.extractFailed, "no JS bundle inside the archive")
        }

        // 5. queue it for the next boot
        lock.lock()
        defer { lock.unlock() }
        if store.state.previousSlot == slot {
          store.state.previousReleaseId = nil
          store.state.previousSlot = nil
          store.state.previousLabel = nil
        }
        store.state.pendingReleaseId = releaseId
        store.state.pendingSlot = slot
        store.state.pendingLabel = (manifest["label"] as? NSNumber)?.intValue
        if previewCandidate?["releaseId"] == releaseId {
          store.state.previewReleaseId = releaseId
        }
        try store.write()

        emit(updateStateEvent, ["state": "pending", "releaseId": releaseId])
        completion(.success(["releaseId": releaseId, "slot": slot]))
      } catch {
        try? FileManager.default.removeItem(at: store.slotDirectory(slot))
        emit(updateStateEvent, [
          "state": "failed", "releaseId": releaseId, "code": (error as? OtaError)?.code,
        ])
        completion(.failure(error))
      }
    }
  }

  /// Promotion itself happens in the boot path; without a reload there is nothing
  /// to do but confirm that something is queued.
  static func applyUpdate(reloadNow: Bool) throws {
    guard store().state.pendingReleaseId != nil else {
      throw OtaError(OtaError.nothingPending, "no update waiting to be applied")
    }
    if reloadNow { reload() }
  }

  /// Promotion already happened in the boot path; this only disarms the crash watchdog.
  static func notifyAppReady() {
    lock.lock()
    defer { lock.unlock() }
    let store = self.store()
    guard store.state.pendingVerification else { return }
    store.state.pendingVerification = false
    try? store.write()
    emit(updateStateEvent, ["state": "ready", "releaseId": store.state.currentReleaseId])
  }

  /// Reloading re-enters `bundleURL()`, which is where the promotion happens.
  static func reload() {
    DispatchQueue.main.async {
      #if canImport(React)
      if let url = OpenOta.bundleURL() {
        RCTReloadCommandSetBundleURL(url)
      }
      RCTTriggerReloadCommandListeners("Open OTA update")
      #else
      NSLog("[OpenOta] React is not linked; the update will apply on the next launch")
      #endif
    }
  }

  static func rollback(reason: String) {
    lock.lock()
    defer { lock.unlock() }
    let store = self.store()
    revert(to: store.state.currentReleaseId, reason: reason)
    try? store.write()
    emit(updateStateEvent, ["state": "rolledBack", "releaseId": store.state.currentReleaseId])
  }

  static func setChannel(_ channel: String?) {
    lock.lock()
    defer { lock.unlock() }
    let trimmed = channel?.trimmingCharacters(in: .whitespacesAndNewlines)
    store().state.channelOverride = (trimmed?.isEmpty ?? true) ? nil : trimmed
    try? store().write()
  }

  static func exitPreview() {
    lock.lock()
    defer { lock.unlock() }
    previewCandidate = nil
    store().state.previewReleaseId = nil
    try? store().write()
  }

  static func clearFailed() {
    lock.lock()
    defer { lock.unlock() }
    store().state.failedReleaseIds = []
    try? store().write()
  }

  static func takePendingEvents() -> [[String: Any]] { store().takeEvents() }

  /* -------------------------------------------------------------- deep links */

  /// Cold starts deliver the link through the launch options, before JS can listen.
  static func pendingPreview() -> [String: String]? {
    guard let candidate = previewCandidate else { return nil }
    return ["d": candidate["d"] ?? "", "s": candidate["s"] ?? ""]
  }

  static func startObservingLinks() {
    guard linkObservers.isEmpty else { return }
    let center = NotificationCenter.default

    // Posted by RCTLinkingManager for every `application(_:open:options:)`.
    linkObservers.append(center.addObserver(
      forName: NSNotification.Name("RCTOpenURLNotification"),
      object: nil,
      queue: .main
    ) { notification in
      _ = try? handleDeepLink(notification.userInfo?["url"] as? String)
    })

    linkObservers.append(center.addObserver(
      forName: UIApplication.didFinishLaunchingNotification,
      object: nil,
      queue: .main
    ) { notification in
      let launched = notification.userInfo?[UIApplication.LaunchOptionsKey.url] as? URL
      _ = try? handleDeepLink(launched?.absoluteString)
    })
  }

  static func stopObservingLinks() {
    linkObservers.forEach { NotificationCenter.default.removeObserver($0) }
    linkObservers = []
  }

  @discardableResult
  static func handleDeepLink(_ link: String?) throws -> Bool {
    guard let link,
          let components = URLComponents(string: link),
          components.host == "ota",
          components.path.hasPrefix("/preview"),
          let query = components.queryItems,
          let d = query.first(where: { $0.name == "d" })?.value,
          let s = query.first(where: { $0.name == "s" })?.value
    else { return false }
    return try handlePreviewToken(d: d, s: s)
  }

  /// Verifies the token from `<scheme>://ota/preview?d&s` (docs/API.md §4.3).
  @discardableResult
  static func handlePreviewToken(d: String, s: String) throws -> Bool {
    let config = self.config()
    guard let decoded = SignatureVerifier.decodeBase64(d),
          let payload = (try? JSONSerialization.jsonObject(with: decoded)) as? [String: Any]
    else { throw OtaError(OtaError.previewInvalid, "preview payload is malformed") }

    guard payload["purpose"] as? String == "preview" else {
      throw OtaError(OtaError.previewInvalid, "token is not a preview token")
    }
    guard SignatureVerifier.verify(
      canonical: CanonicalJson.canonicalize(payload),
      signatureBase64: s,
      publicKeyPem: config.publicKey
    ) else {
      throw OtaError(OtaError.previewInvalid, "preview signature does not verify")
    }
    guard payload["projectId"] as? String == config.projectId else {
      throw OtaError(OtaError.previewInvalid, "preview token belongs to another project")
    }
    let exp = (payload["exp"] as? NSNumber)?.doubleValue ?? 0
    guard exp + previewClockSkewSeconds >= Date().timeIntervalSince1970 else {
      throw OtaError(OtaError.previewInvalid, "preview token expired")
    }

    previewCandidate = ["d": d, "s": s, "releaseId": payload["releaseId"] as? String ?? ""]
    emit(previewRequestedEvent, ["d": d, "s": s])
    return true
  }

  /* --------------------------------------------------------------- internals */

  private static func promotePending() {
    let store = self.store()
    guard let pending = store.state.pendingReleaseId else { return }
    if store.state.currentSlot != store.state.pendingSlot {
      store.state.previousReleaseId = store.state.currentReleaseId
      store.state.previousSlot = store.state.currentSlot
      store.state.previousLabel = store.state.currentLabel
    }
    store.state.currentReleaseId = pending
    store.state.currentSlot = store.state.pendingSlot
    store.state.currentLabel = store.state.pendingLabel
    store.state.pendingReleaseId = nil
    store.state.pendingSlot = nil
    store.state.pendingLabel = nil
    store.state.pendingVerification = true
  }

  /// Drops the broken release and falls back one step; the slot itself is left to
  /// be overwritten by the next download (no recursive delete on the boot thread).
  private static func revert(to releaseId: String?, reason: String) {
    let store = self.store()
    if let releaseId {
      store.state.failedReleaseIds.removeAll { $0 == releaseId }
      store.state.failedReleaseIds.append(releaseId)
      if store.state.failedReleaseIds.count > maxFailed {
        store.state.failedReleaseIds.removeFirst(store.state.failedReleaseIds.count - maxFailed)
      }
      var meta: [String: Any] = ["reason": reason]
      if let restored = store.state.previousReleaseId { meta["from"] = restored }
      store.appendEvent([
        "type": "rollback",
        "release": releaseId,
        "ts": Int(Date().timeIntervalSince1970),
        "meta": meta,
      ])
    }
    store.state.currentReleaseId = store.state.previousReleaseId
    store.state.currentSlot = store.state.previousSlot
    store.state.currentLabel = store.state.previousLabel
    store.state.previousReleaseId = nil
    store.state.previousSlot = nil
    store.state.previousLabel = nil
    store.state.pendingReleaseId = nil
    store.state.pendingSlot = nil
    store.state.pendingLabel = nil
    store.state.pendingVerification = false
    store.state.previewReleaseId = nil
  }

  /// A new binary always carries a newer floor, so this also clears bundles built
  /// for a runtimeVersion this binary no longer speaks.
  private static func dropReleasesBelowFloor() {
    guard let floor = config().embeddedFloorId else { return }
    let store = self.store()
    if let pending = store.state.pendingReleaseId, pending <= floor {
      store.state.pendingReleaseId = nil
      store.state.pendingSlot = nil
      store.state.pendingLabel = nil
    }
    if let previous = store.state.previousReleaseId, previous <= floor {
      store.state.previousReleaseId = nil
      store.state.previousSlot = nil
      store.state.previousLabel = nil
    }
    if let current = store.state.currentReleaseId, current <= floor {
      store.state.currentReleaseId = nil
      store.state.currentSlot = nil
      store.state.currentLabel = nil
      store.state.pendingVerification = false
      store.state.previewReleaseId = nil
    }
  }

  private static func resolveCurrent() -> URL? {
    let store = self.store()
    guard store.state.currentReleaseId != nil, let slot = store.state.currentSlot else { return nil }
    return resolveBundle(in: store.slotDirectory(slot))
  }

  /// The zip keeps the `expo export` layout, so the entry point can be either a
  /// plain bundle at the root or the file metadata.json points at.
  private static func resolveBundle(in slot: URL) -> URL? {
    let manager = FileManager.default
    guard manager.fileExists(atPath: slot.path) else { return nil }

    for name in bundleNames {
      let candidate = slot.appendingPathComponent(name)
      if manager.fileExists(atPath: candidate.path) { return candidate }
    }

    let metadata = slot.appendingPathComponent("metadata.json")
    if let data = try? Data(contentsOf: metadata),
       let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let files = json["fileMetadata"] as? [String: Any],
       let platformFiles = files[platform] as? [String: Any],
       let relative = platformFiles["bundle"] as? String {
      let candidate = slot.appendingPathComponent(relative)
      if manager.fileExists(atPath: candidate.path) { return candidate }
    }

    return searchBundle(in: slot, depth: 0)
  }

  private static func searchBundle(in directory: URL, depth: Int) -> URL? {
    guard depth <= 6,
          let entries = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey]
          )
    else { return nil }

    let files = entries
      .filter { ["hbc", "bundle"].contains($0.pathExtension) }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    if let first = files.first { return first }

    for entry in entries where entry.lastPathComponent != "assets" {
      var isDirectory: ObjCBool = false
      FileManager.default.fileExists(atPath: entry.path, isDirectory: &isDirectory)
      if isDirectory.boolValue, let found = searchBundle(in: entry, depth: depth + 1) { return found }
    }
    return nil
  }

  private static func deviceId() -> String {
    let store = self.store()
    if let existing = store.state.deviceId { return existing }
    let created = UUID().uuidString.lowercased()
    store.state.deviceId = created
    try? store.write()
    return created
  }

  private static func store() -> UpdateStore {
    if let storeRef { return storeRef }
    let created = UpdateStore()
    storeRef = created
    return created
  }

  private static func config() -> OtaConfig {
    if let configRef { return configRef }
    let created = OtaConfig.load()
    configRef = created
    return created
  }

  private static func emit(_ name: String, _ body: [String: Any?]) {
    emitter?(name, body)
  }
}
