import Foundation

/**
 Vectors produced by packages/shared/src/canonical.ts. If one of these fails,
 every signature this SDK verifies is verifying different bytes than the server
 signed.

 Not part of the pod — run it standalone:
   swiftc ios/CanonicalJson.swift ios/Tests/CanonicalJsonTests.swift -o /tmp/ota-canonical && /tmp/ota-canonical
 */
@main
struct CanonicalJsonTests {

  static func main() {
    manifestKeysAreSortedAndWhitespaceFree()
    previewTokenPayload()
    escapingAndKeyOrderMatchJsonStringify()
    print("canonical json: ok")
  }

  static func manifestKeysAreSortedAndWhitespaceFree() {
    let received = """
    {"id":"0193a4c8-0000-7000-8000-000000000001","projectId":"prj_x","platform":"ios",
     "channel":"production","runtimeVersion":"fp_9f8e7d","label":42,
     "sha256":"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
     "size":4812345,"createdAt":"2026-09-01T12:00:00Z"}
    """
    expect(
      CanonicalJson.canonicalize(CanonicalJson.parse(received)),
      """
      {"channel":"production","createdAt":"2026-09-01T12:00:00Z",\
      "id":"0193a4c8-0000-7000-8000-000000000001","label":42,"platform":"ios",\
      "projectId":"prj_x","runtimeVersion":"fp_9f8e7d",\
      "sha256":"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",\
      "size":4812345}
      """
    )
  }

  static func previewTokenPayload() {
    let received = """
    {"purpose":"preview","projectId":"prj_x","releaseId":"0193a4c8-0000-7000-8000-000000000001","exp":1756732500}
    """
    expect(
      CanonicalJson.canonicalize(CanonicalJson.parse(received)),
      """
      {"exp":1756732500,"projectId":"prj_x","purpose":"preview",\
      "releaseId":"0193a4c8-0000-7000-8000-000000000001"}
      """
    )
  }

  static func escapingAndKeyOrderMatchJsonStringify() {
    let value: [String: Any] = [
      "z": "q\" b\\ n\n t\t c\u{01} ",
      "a\u{E9}": "emoji \u{1F600}",
      "b": [1, -0.0, true, NSNull(), 3.5] as [Any],
      "Z": "upper",
      "": "empty",
    ]
    expect(
      CanonicalJson.canonicalize(value),
      "{\"\":\"empty\",\"Z\":\"upper\",\"a\u{E9}\":\"emoji \u{1F600}\","
        + "\"b\":[1,0,true,null,3.5],\"z\":\"q\\\" b\\\\ n\\n t\\t c\\u0001 \"}"
    )
  }

  static func expect(_ actual: String, _ expected: String) {
    guard actual == expected else {
      FileHandle.standardError.write(Data("expected:\n\(expected)\nactual:\n\(actual)\n".utf8))
      exit(1)
    }
  }
}
