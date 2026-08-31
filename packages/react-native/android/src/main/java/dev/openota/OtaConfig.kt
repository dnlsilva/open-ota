package dev.openota

import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle

/**
 * Values the config plugin (Expo) or the `ota init` codemod (bare RN) bakes into
 * the binary, as <meta-data> on <application>:
 *
 *   dev.openota.API_URL           https://ota.example.com
 *   dev.openota.APP_KEY           pk_...
 *   dev.openota.PROJECT_ID        prj_...
 *   dev.openota.CHANNEL           production
 *   dev.openota.RUNTIME_VERSION   fp_...            (@expo/fingerprint)
 *   dev.openota.PUBLIC_KEY        PEM or bare base64 SPKI
 *   dev.openota.EMBEDDED_FLOOR_ID UUIDv7 stamped at build time
 *   dev.openota.DEEP_LINK_SCHEME  myapp
 */
internal data class OtaConfig(
  val apiUrl: String,
  val appKey: String,
  val projectId: String,
  val channel: String,
  val runtimeVersion: String,
  val publicKey: String,
  val embeddedFloorId: String?,
  val nativeVersion: String,
  val deepLinkScheme: String?,
) {
  val isConfigured: Boolean get() = projectId.isNotEmpty() && publicKey.isNotEmpty()

  fun toMap(): Map<String, Any?> = mapOf(
    "apiUrl" to apiUrl,
    "appKey" to appKey,
    "projectId" to projectId,
    "channel" to channel,
    "runtimeVersion" to runtimeVersion,
    "publicKey" to publicKey,
    "embeddedFloorId" to embeddedFloorId,
    "nativeVersion" to nativeVersion,
    "deepLinkScheme" to deepLinkScheme,
  )

  companion object {
    private const val PREFIX = "dev.openota."

    fun from(context: Context): OtaConfig {
      val app = context.applicationContext
      val meta = runCatching {
        app.packageManager
          .getApplicationInfo(app.packageName, PackageManager.GET_META_DATA)
          .metaData
      }.getOrNull()

      val nativeVersion = runCatching {
        app.packageManager.getPackageInfo(app.packageName, 0).versionName
      }.getOrNull().orEmpty()

      return OtaConfig(
        apiUrl = meta.value(app, "API_URL").orEmpty().trimEnd('/'),
        appKey = meta.value(app, "APP_KEY").orEmpty(),
        projectId = meta.value(app, "PROJECT_ID").orEmpty(),
        channel = meta.value(app, "CHANNEL") ?: "production",
        runtimeVersion = meta.value(app, "RUNTIME_VERSION").orEmpty(),
        publicKey = meta.value(app, "PUBLIC_KEY").orEmpty(),
        embeddedFloorId = meta.value(app, "EMBEDDED_FLOOR_ID"),
        nativeVersion = nativeVersion,
        deepLinkScheme = meta.value(app, "DEEP_LINK_SCHEME"),
      )
    }

    @Suppress("DEPRECATION") // Bundle.get is the only untyped meta-data read
    private fun Bundle?.value(context: Context, key: String): String? =
      when (val raw = this?.get(PREFIX + key)) {
        is String -> raw.ifEmpty { null }
        // A plugin may emit android:value="@string/..." — meta-data then carries the resource id.
        is Int -> runCatching { context.getString(raw) }.getOrNull()
        null -> null
        else -> raw.toString()
      }
  }
}
