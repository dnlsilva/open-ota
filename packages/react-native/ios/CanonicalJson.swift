import Foundation

/**
 Byte-for-byte mirror of packages/shared/src/canonical.ts.

 Signatures are verified over this re-serialization, never over the bytes that
 arrived on the wire — otherwise a manifest could be padded with unsigned data
 that the JS layer would still read.
 */
enum CanonicalJson {

  static func parse(_ text: String) -> Any? {
    guard let data = text.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  }

  static func canonicalize(_ value: Any?) -> String {
    var out = ""
    write(value, into: &out)
    return out
  }

  private static func write(_ maybe: Any?, into out: inout String) {
    guard let value = maybe, !(value is NSNull) else {
      out += "null"
      return
    }
    switch value {
    case let text as String:
      writeString(text, into: &out)
    case let number as NSNumber:
      writeNumber(number, into: &out)
    case let array as [Any]:
      out += "["
      for (index, item) in array.enumerated() {
        if index > 0 { out += "," }
        write(item, into: &out)
      }
      out += "]"
    case let object as [String: Any]:
      // JS sorts with Array#sort, which compares UTF-16 code units; Swift's own
      // String ordering does not, so compare the code units explicitly.
      let keys = object.keys.sorted(by: lessThanByUtf16)
      out += "{"
      for (index, key) in keys.enumerated() {
        if index > 0 { out += "," }
        writeString(key, into: &out)
        out += ":"
        write(object[key], into: &out)
      }
      out += "}"
    default:
      out += "null"
    }
  }

  private static func lessThanByUtf16(_ lhs: String, _ rhs: String) -> Bool {
    var left = lhs.utf16.makeIterator()
    var right = rhs.utf16.makeIterator()
    while true {
      switch (left.next(), right.next()) {
      case let (l?, r?) where l != r: return l < r
      case (_?, nil): return false
      case (nil, _?): return true
      case (nil, nil): return false
      default: continue
      }
    }
  }

  private static func writeNumber(_ number: NSNumber, into out: inout String) {
    if CFGetTypeID(number) == CFBooleanGetTypeID() {
      out += number.boolValue ? "true" : "false"
      return
    }
    let value = number.doubleValue
    // ponytail: signed payloads only carry integers (label, size, exp). Real
    // fractions would need JS shortest-round-trip formatting to match.
    if value == value.rounded(.towardZero), abs(value) < 9_007_199_254_740_992 {
      out += String(Int64(value))
    } else {
      out += String(value)
    }
  }

  private static func writeString(_ value: String, into out: inout String) {
    out += "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          // Everything else stays literal, including astral planes — a Swift
          // String cannot hold the lone surrogates JSON.stringify escapes.
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
  }
}
