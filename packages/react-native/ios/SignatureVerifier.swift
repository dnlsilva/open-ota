import Foundation
import Security

/// RSA-2048 / SHA-256 detached signatures over canonical JSON (docs/API.md §4.2).
enum SignatureVerifier {

  static func verify(canonical: String, signatureBase64: String, publicKeyPem: String) -> Bool {
    guard let der = decodeBase64(publicKeyPem),
          let signature = decodeBase64(signatureBase64),
          let key = publicKey(from: der)
    else { return false }

    return SecKeyVerifySignature(
      key,
      .rsaSignatureMessagePKCS1v15SHA256,
      Data(canonical.utf8) as CFData,
      signature as CFData,
      nil
    )
  }

  private static func publicKey(from der: Data) -> SecKey? {
    // SecKeyCreateWithData wants a bare PKCS#1 RSAPublicKey; the server ships SPKI.
    let raw = pkcs1(fromSpki: der) ?? der
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
    ]
    return SecKeyCreateWithData(raw as CFData, attributes as CFDictionary, nil)
  }

  /// SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { RSAPublicKey } }
  private static func pkcs1(fromSpki der: Data) -> Data? {
    let bytes = [UInt8](der)
    var cursor = 0
    guard readHeader(bytes, &cursor, tag: 0x30) != nil,
          let algorithmLength = readHeader(bytes, &cursor, tag: 0x30)
    else { return nil }
    cursor += algorithmLength

    guard let bitStringLength = readHeader(bytes, &cursor, tag: 0x03),
          bitStringLength > 1,
          cursor < bytes.count,
          bytes[cursor] == 0x00, // unused-bits count
          cursor + bitStringLength <= bytes.count
    else { return nil }

    return Data(bytes[(cursor + 1)..<(cursor + bitStringLength)])
  }

  private static func readHeader(_ bytes: [UInt8], _ cursor: inout Int, tag: UInt8) -> Int? {
    guard cursor + 1 < bytes.count, bytes[cursor] == tag else { return nil }
    cursor += 1
    var length = Int(bytes[cursor])
    cursor += 1
    if length & 0x80 != 0 {
      let byteCount = length & 0x7F
      guard byteCount > 0, byteCount <= 4, cursor + byteCount <= bytes.count else { return nil }
      length = 0
      for _ in 0..<byteCount {
        length = (length << 8) | Int(bytes[cursor])
        cursor += 1
      }
    }
    return length
  }

  /// Tolerates PEM armor, wrapped lines, base64url and missing padding — the
  /// public key travels through Info.plist and the signature through a URL.
  static func decodeBase64(_ text: String) -> Data? {
    var body = text.replacingOccurrences(
      of: "-----[A-Z ]+-----",
      with: "",
      options: .regularExpression
    )
    body = body.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    body = String(String.UnicodeScalarView(body.unicodeScalars.filter { allowed.contains($0) }))
    while body.count % 4 != 0 { body += "=" }
    return Data(base64Encoded: body)
  }

  private static let allowed = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
  )
}
