import Foundation

/**
 Values the config plugin (Expo) or the `ota init` codemod (bare RN) bakes into
 the binary. iOS carries them as flat `OpenOta*` keys in Info.plist:

   <key>OpenOtaApiUrl</key>          <string>https://ota.example.com</string>
   <key>OpenOtaAppKey</key>          <string>pk_...</string>
   <key>OpenOtaProjectId</key>       <string>prj_...</string>
   <key>OpenOtaChannel</key>         <string>production</string>
   <key>OpenOtaRuntimeVersion</key>  <string>fp_...</string>   <!-- @expo/fingerprint -->
   <key>OpenOtaPublicKey</key>       <string>PEM or bare base64 SPKI</string>
   <key>OpenOtaEmbeddedFloorId</key> <string>UUIDv7 stamped at build time</string>
   <key>OpenOtaDeepLinkScheme</key>  <string>myapp</string>

 Flat on purpose: both writers — the Expo plugin's plist mod and the bare-RN
 XML codemod — insert simple key/string pairs, and a nested dict would give the
 XML codemod a structure to parse instead of a line to add. The Android side
 reads the same names as `dev.openota.<UPPER_SNAKE>` meta-data.
 Key names live in plugin/codemods/edits.js (IOS_PLIST) — keep in step.
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
    func value(_ key: String) -> String? {
      guard let text = bundle.object(forInfoDictionaryKey: "OpenOta" + key) as? String,
            !text.isEmpty
      else { return nil }
      return text
    }

    var apiUrl = value("ApiUrl") ?? ""
    while apiUrl.hasSuffix("/") { apiUrl.removeLast() }

    return OtaConfig(
      apiUrl: apiUrl,
      appKey: value("AppKey") ?? "",
      projectId: value("ProjectId") ?? "",
      channel: value("Channel") ?? "production",
      runtimeVersion: value("RuntimeVersion") ?? "",
      publicKey: value("PublicKey") ?? "",
      embeddedFloorId: value("EmbeddedFloorId"),
      nativeVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
      deepLinkScheme: value("DeepLinkScheme")
    )
  }
}
