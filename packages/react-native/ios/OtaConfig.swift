import Foundation

/**
 Values the config plugin (Expo) or the `ota init` codemod (bare RN) bakes into
 the binary. iOS carries them in Info.plist under an `OpenOta` dictionary:

   <key>OpenOta</key>
   <dict>
     <key>apiUrl</key>           <string>https://ota.example.com</string>
     <key>appKey</key>           <string>pk_...</string>
     <key>projectId</key>        <string>prj_...</string>
     <key>channel</key>          <string>production</string>
     <key>runtimeVersion</key>   <string>fp_...</string>   <!-- @expo/fingerprint -->
     <key>publicKey</key>        <string>PEM or bare base64 SPKI</string>
     <key>embeddedFloorId</key>  <string>UUIDv7 stamped at build time</string>
     <key>deepLinkScheme</key>   <string>myapp</string>
   </dict>

 The Android side reads the same names as `dev.openota.<UPPER_SNAKE>` meta-data.
 */
struct OtaConfig {
  let apiUrl: String
  let appKey: String
  let projectId: String
  let channel: String
  let runtimeVersion: String
  let publicKey: String
  let embeddedFloorId: String?
  let nativeVersion: String
  let deepLinkScheme: String?

  var isConfigured: Bool { !projectId.isEmpty && !publicKey.isEmpty }

  var asDictionary: [String: Any?] {
    [
      "apiUrl": apiUrl,
      "appKey": appKey,
      "projectId": projectId,
      "channel": channel,
      "runtimeVersion": runtimeVersion,
      "publicKey": publicKey,
      "embeddedFloorId": embeddedFloorId,
      "nativeVersion": nativeVersion,
      "deepLinkScheme": deepLinkScheme,
    ]
  }

  static func load(from bundle: Bundle = .main) -> OtaConfig {
    let values = bundle.object(forInfoDictionaryKey: "OpenOta") as? [String: Any] ?? [:]
    func value(_ key: String) -> String? {
      guard let text = values[key] as? String, !text.isEmpty else { return nil }
      return text
    }

    var apiUrl = value("apiUrl") ?? ""
    while apiUrl.hasSuffix("/") { apiUrl.removeLast() }

    return OtaConfig(
      apiUrl: apiUrl,
      appKey: value("appKey") ?? "",
      projectId: value("projectId") ?? "",
      channel: value("channel") ?? "production",
      runtimeVersion: value("runtimeVersion") ?? "",
      publicKey: value("publicKey") ?? "",
      embeddedFloorId: value("embeddedFloorId"),
      nativeVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
      deepLinkScheme: value("deepLinkScheme")
    )
  }
}
