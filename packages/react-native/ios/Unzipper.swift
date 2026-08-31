import Compression
import Foundation

/**
 Minimal ZIP reader — stored and deflated entries, which is all `expo export`
 produces. Avoids pulling a compression pod into every host app.
 */
enum Unzipper {

  private static let endOfCentralDirectory: UInt32 = 0x0605_4B50
  private static let centralFileHeader: UInt32 = 0x0201_4B50
  private static let localFileHeader: UInt32 = 0x0403_4B50

  static func unzip(_ zipURL: URL, into target: URL, maxBytes: Int) throws {
    let manager = FileManager.default
    try? manager.removeItem(at: target)
    try manager.createDirectory(at: target, withIntermediateDirectories: true)

    let data = try Data(contentsOf: zipURL, options: .mappedIfSafe)
    guard let eocd = findEndOfCentralDirectory(data) else {
      throw OtaError(OtaError.extractFailed, "not a zip archive")
    }

    var cursor = Int(read32(data, eocd + 16))
    // `standardized` is purely lexical; `standardizedFileURL` also consults the
    // file system and would normalize an existing directory differently from a
    // path that does not exist yet.
    let root = target.standardized.path
    var written = 0

    // Walking by signature instead of by the EOCD entry count keeps archives with
    // more than 65535 entries working. ponytail: zip64 sizes are still unsupported.
    while cursor + 46 <= data.count, read32(data, cursor) == centralFileHeader {
      let method = read16(data, cursor + 10)
      let compressedSize = Int(read32(data, cursor + 20))
      let uncompressedSize = Int(read32(data, cursor + 24))
      let nameLength = Int(read16(data, cursor + 28))
      let extraLength = Int(read16(data, cursor + 30))
      let commentLength = Int(read16(data, cursor + 32))
      let localOffset = Int(read32(data, cursor + 42))
      guard cursor + 46 + nameLength <= data.count,
            let name = String(data: data.subdata(in: (cursor + 46)..<(cursor + 46 + nameLength)), encoding: .utf8)
      else { throw OtaError(OtaError.extractFailed, "unreadable zip entry name") }
      cursor += 46 + nameLength + extraLength + commentLength

      let normalized = name.replacingOccurrences(of: "\\", with: "/")
      guard !normalized.hasPrefix("/"), !normalized.split(separator: "/").contains("..") else {
        throw OtaError(OtaError.extractFailed, "zip entry escapes the slot: \(name)")
      }

      let destination = target.appendingPathComponent(normalized).standardized
      guard destination.path == root || destination.path.hasPrefix(root + "/") else {
        throw OtaError(OtaError.extractFailed, "zip entry escapes the slot: \(name)")
      }

      if normalized.hasSuffix("/") {
        try manager.createDirectory(at: destination, withIntermediateDirectories: true)
        continue
      }

      written += uncompressedSize
      guard written <= maxBytes else {
        throw OtaError(OtaError.extractFailed, "bundle exceeds \(maxBytes) bytes")
      }

      guard localOffset + 30 <= data.count, read32(data, localOffset) == localFileHeader else {
        throw OtaError(OtaError.extractFailed, "corrupt local header for \(name)")
      }
      // The local header carries its own extra-field length, often different
      // from the one in the central directory.
      let start = localOffset + 30 + Int(read16(data, localOffset + 26)) + Int(read16(data, localOffset + 28))
      guard start + compressedSize <= data.count else {
        throw OtaError(OtaError.extractFailed, "truncated entry \(name)")
      }
      let payload = data.subdata(in: start..<(start + compressedSize))

      let contents: Data
      switch method {
      case 0: contents = payload
      case 8: contents = try inflate(payload, expected: uncompressedSize)
      default: throw OtaError(OtaError.extractFailed, "unsupported compression \(method)")
      }

      try manager.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try contents.write(to: destination)
    }
  }

  private static func inflate(_ data: Data, expected: Int) throws -> Data {
    if expected == 0 { return Data() }
    var output = Data(count: expected)
    let produced: Int = output.withUnsafeMutableBytes { destination in
      data.withUnsafeBytes { source in
        guard let destinationBase = destination.bindMemory(to: UInt8.self).baseAddress,
              let sourceBase = source.bindMemory(to: UInt8.self).baseAddress
        else { return 0 }
        // COMPRESSION_ZLIB is raw DEFLATE, which is exactly zip method 8.
        return compression_decode_buffer(
          destinationBase, expected, sourceBase, data.count, nil, COMPRESSION_ZLIB
        )
      }
    }
    guard produced == expected else {
      throw OtaError(OtaError.extractFailed, "inflate produced \(produced) of \(expected) bytes")
    }
    return output
  }

  private static func findEndOfCentralDirectory(_ data: Data) -> Int? {
    guard data.count >= 22 else { return nil }
    let lowest = max(0, data.count - 22 - 65_535)
    var offset = data.count - 22
    while offset >= lowest {
      if read32(data, offset) == endOfCentralDirectory { return offset }
      offset -= 1
    }
    return nil
  }

  private static func read16(_ data: Data, _ offset: Int) -> UInt16 {
    UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
  }

  private static func read32(_ data: Data, _ offset: Int) -> UInt32 {
    guard offset + 4 <= data.count else { return 0 }
    return UInt32(data[offset])
      | (UInt32(data[offset + 1]) << 8)
      | (UInt32(data[offset + 2]) << 16)
      | (UInt32(data[offset + 3]) << 24)
  }
}
