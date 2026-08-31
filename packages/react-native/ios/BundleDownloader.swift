import CryptoKit
import Foundation

final class BundleDownloader: NSObject, URLSessionDownloadDelegate {

  private let target: URL
  private let expectedSize: Int64
  private let maxBytes: Int64
  private let onProgress: (Int64, Int64) -> Void
  private let completion: (Result<String, Error>) -> Void
  private var session: URLSession?
  private var lastEmit = Date.distantPast
  private var settled = false

  /// Streams `url` into `target` and reports the SHA-256 of what landed there.
  @discardableResult
  init(
    url: URL,
    target: URL,
    expectedSize: Int64,
    maxBytes: Int64,
    onProgress: @escaping (Int64, Int64) -> Void,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    self.target = target
    self.expectedSize = expectedSize
    self.maxBytes = maxBytes
    self.onProgress = onProgress
    self.completion = completion
    super.init()

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 60 * 30
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    // The session retains this delegate until it is invalidated in finish().
    session.downloadTask(with: url).resume()
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    if totalBytesWritten > maxBytes {
      downloadTask.cancel()
      finish(.failure(OtaError(OtaError.downloadFailed, "bundle exceeds \(maxBytes) bytes")))
      return
    }
    let now = Date()
    guard now.timeIntervalSince(lastEmit) >= 0.1 else { return }
    lastEmit = now
    let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedSize
    onProgress(totalBytesWritten, total)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    if let response = downloadTask.response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
      finish(.failure(OtaError(OtaError.downloadFailed, "HTTP \(response.statusCode)")))
      return
    }
    do {
      // The temp file is gone the moment this delegate returns.
      try? FileManager.default.createDirectory(
        at: target.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.moveItem(at: location, to: target)
      let digest = try BundleDownloader.sha256(of: target)
      let size = fileSize(target)
      onProgress(size, size)
      finish(.success(digest))
    } catch {
      finish(.failure(OtaError(OtaError.downloadFailed, error.localizedDescription)))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error else { return }
    finish(.failure(OtaError(OtaError.downloadFailed, error.localizedDescription)))
  }

  private func finish(_ result: Result<String, Error>) {
    guard !settled else { return }
    settled = true
    session?.finishTasksAndInvalidate()
    session = nil
    completion(result)
  }

  private func fileSize(_ url: URL) -> Int64 {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
  }

  static func sha256(of url: URL) throws -> String {
    var hasher = SHA256()
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
