package dev.openota

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.UiThreadUtil
import org.json.JSONObject
import java.io.File
import java.lang.reflect.Field

/**
 * Core of the Android SDK, and the boot path the host app calls before any JS
 * exists — from `ReactNativeHost.getJSBundleFile()` (bridge) or from whatever
 * builds the `ReactHost` (bridgeless).
 */
object OpenOta {

  const val EVENT_DOWNLOAD_PROGRESS = "downloadProgress"
  const val EVENT_UPDATE_STATE = "updateState"
  const val EVENT_PREVIEW_REQUESTED = "previewRequested"

  private const val TAG = "OpenOta"
  private const val PLATFORM = "android"
  private const val MAX_FAILED = 10
  private const val MAX_BUNDLE_BYTES = 200L * 1024 * 1024
  private const val PREVIEW_CLOCK_SKEW_SECONDS = 300L
  private val BUNDLE_NAMES = listOf("index.android.bundle", "main.jsbundle", "index.bundle")

  @Volatile var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  private var appContext: Context? = null
  private var storeRef: UpdateStore? = null
  private var configRef: OtaConfig? = null

  /** The crash check may only run once per process — reload() re-enters here. */
  private var bootHandled = false
  private var previewCandidate: Map<String, Any?>? = null

  /* ------------------------------------------------------------- boot path */

  /**
   * Absolute path of the JS bundle to run, or null for the embedded one.
   * Synchronous, no network: it only reads local state.
   */
  @JvmStatic
  fun getBundleFile(context: Context): String? = synchronized(this) {
    attach(context)
    try {
      val store = store()
      val state = store.state

      if (!bootHandled) {
        bootHandled = true
        // A launch that armed pendingVerification and never called notifyAppReady
        // died before the JS could confirm itself. One strike is enough.
        if (state.pendingVerification) revert(state, state.currentReleaseId, "crash")
      }

      dropReleasesBelowFloor(state)
      promotePending(state)
      // The flag has to be on disk BEFORE React Native gets the path, otherwise a
      // crash during the very first frame looks like a clean launch next time.
      store.write(state)

      var path = resolveCurrent(store, state)
      if (path == null && state.currentReleaseId != null) {
        revert(state, state.currentReleaseId, "missing")
        store.write(state)
        path = resolveCurrent(store, state)
      }
      path
    } catch (t: Throwable) {
      // Never let the update layer stop the app from booting.
      Log.e(TAG, "boot path failed, falling back to the embedded bundle", t)
      null
    }
  }

  @JvmStatic
  fun attach(context: Context) {
    if (appContext == null) appContext = context.applicationContext
  }

  /* -------------------------------------------------------------- lifecycle */

  fun status(): Map<String, Any?> {
    val store = store()
    val state = store.state
    val config = config()
    return mapOf(
      "deviceId" to DeviceId.getOrCreate(store),
      "channel" to (state.channelOverride ?: config.channel),
      "runtimeVersion" to config.runtimeVersion,
      "nativeVersion" to config.nativeVersion,
      "currentRelease" to state.currentReleaseId?.let {
        mapOf("id" to it, "label" to state.currentLabel)
      },
      "isPreview" to (state.previewReleaseId != null),
      "pendingRelease" to state.pendingReleaseId?.let {
        mapOf("id" to it, "label" to state.pendingLabel)
      },
      "failedReleaseIds" to state.failedReleaseIds.toList(),
      "embeddedFloorId" to config.embeddedFloorId,
    )
  }

  fun constants(context: Context): Map<String, Any?> {
    attach(context)
    return config().toMap()
  }

  fun downloadUpdate(manifestJson: String, signatureBase64: String, url: String): Map<String, Any?> {
    val config = config()
    if (!config.isConfigured) {
      throw OtaError(OtaError.NOT_CONFIGURED, "no projectId/publicKey baked into this binary")
    }

    val manifest = try {
      JSONObject(manifestJson)
    } catch (t: Throwable) {
      throw OtaError(OtaError.MANIFEST_MISMATCH, "manifest is not valid JSON", t)
    }

    // 1. authenticity, over our own canonical re-serialization
    if (!SignatureVerifier.verify(
        CanonicalJson.canonicalize(manifest),
        signatureBase64,
        config.publicKey,
      )
    ) {
      throw OtaError(OtaError.SIGNATURE_INVALID, "manifest signature does not verify")
    }

    // 2. does this manifest even belong to this binary
    val releaseId = manifest.optString("id")
    val store = store()
    val state = store.state
    fun mismatch(what: String): Nothing =
      throw OtaError(OtaError.MANIFEST_MISMATCH, "manifest $what does not match this build")

    if (releaseId.isEmpty()) mismatch("id")
    if (manifest.optString("projectId") != config.projectId) mismatch("projectId")
    if (manifest.optString("platform") != PLATFORM) mismatch("platform")
    if (manifest.optString("runtimeVersion") != config.runtimeVersion) mismatch("runtimeVersion")
    if (state.failedReleaseIds.contains(releaseId)) mismatch("release already failed here")
    config.embeddedFloorId?.let { floor ->
      // UUIDv7 sorts by time as plain text, so this rejects an OTA older than the binary.
      if (releaseId <= floor) mismatch("release predates the embedded bundle")
    }

    val sha256 = manifest.optString("sha256").lowercase()
    val size = manifest.optLong("size")
    val slot = store.freeSlot()
    val zip = File(store.tmpDir, "$releaseId.zip")

    emit(EVENT_UPDATE_STATE, mapOf("state" to "downloading", "releaseId" to releaseId))
    try {
      // 3. transfer
      val actual = BundleDownloader.download(url, zip, size, MAX_BUNDLE_BYTES) { written, total ->
        emit(EVENT_DOWNLOAD_PROGRESS, mapOf("written" to written, "total" to total))
      }

      // 4. integrity
      if (!actual.equals(sha256, ignoreCase = true)) {
        throw OtaError(OtaError.HASH_MISMATCH, "sha256 $actual != $sha256")
      }

      // 5. install
      Unzipper.unzip(zip, store.slotDir(slot), MAX_BUNDLE_BYTES)
      if (resolveBundle(store.slotDir(slot)) == null) {
        throw OtaError(OtaError.EXTRACT_FAILED, "no JS bundle inside the archive")
      }

      // 6. queue it for the next boot
      if (state.previousSlot == slot) {
        state.previousReleaseId = null
        state.previousSlot = null
        state.previousLabel = null
      }
      state.pendingReleaseId = releaseId
      state.pendingSlot = slot
      state.pendingLabel = if (manifest.has("label")) manifest.optInt("label") else null
      if (previewCandidate?.get("releaseId") == releaseId) state.previewReleaseId = releaseId
      store.write(state)
    } catch (t: Throwable) {
      store.slotDir(slot).deleteRecursively()
      emit(
        EVENT_UPDATE_STATE,
        mapOf("state" to "failed", "releaseId" to releaseId, "code" to (t as? OtaError)?.code),
      )
      throw if (t is OtaError) t else OtaError(OtaError.DOWNLOAD_FAILED, t.message ?: "install failed", t)
    } finally {
      zip.delete()
    }

    emit(EVENT_UPDATE_STATE, mapOf("state" to "pending", "releaseId" to releaseId))
    return mapOf("releaseId" to releaseId, "slot" to slot)
  }

  /** Promotion itself happens in the boot path; without a reload there is nothing
   *  to do but confirm that something is queued. */
  fun applyUpdate(reloadNow: Boolean) {
    val state = store().state
    if (state.pendingReleaseId == null) {
      throw OtaError(OtaError.NOTHING_PENDING, "no update waiting to be applied")
    }
    if (reloadNow) reload()
  }

  /** Promotion already happened in the boot path; this only disarms the crash watchdog. */
  fun notifyAppReady() {
    synchronized(this) {
      val store = store()
      val state = store.state
      if (state.pendingVerification) {
        state.pendingVerification = false
        store.write(state)
        emit(EVENT_UPDATE_STATE, mapOf("state" to "ready", "releaseId" to state.currentReleaseId))
      }
    }
  }

  fun reload() {
    val context = requireContext()
    val store = store()
    val snapshot = store.state.snapshot()
    val hadPending = store.state.pendingReleaseId != null

    val path = getBundleFile(context)
    if (!swapBundle(context, path) && hadPending) {
      // Reloading without swapping would run the old bundle while state claims the
      // new one is live — and would arm a crash rollback against an innocent release.
      store.restore(snapshot)
      throw OtaError(
        OtaError.RELOAD_UNSUPPORTED,
        "could not hand the new bundle to React Native; it will apply on the next launch",
      )
    }
    UiThreadUtil.runOnUiThread { triggerReload(context) }
  }

  fun rollback(reason: String) {
    synchronized(this) {
      val store = store()
      val state = store.state
      revert(state, state.currentReleaseId, reason)
      store.write(state)
      emit(EVENT_UPDATE_STATE, mapOf("state" to "rolledBack", "releaseId" to state.currentReleaseId))
    }
  }

  fun setChannel(channel: String?) {
    val store = store()
    store.state.channelOverride = channel?.takeIf { it.isNotBlank() }
    store.write()
  }

  fun exitPreview() {
    val store = store()
    previewCandidate = null
    store.state.previewReleaseId = null
    store.write()
  }

  fun clearFailed() {
    val store = store()
    store.state.failedReleaseIds.clear()
    store.write()
  }

  fun takePendingEvents(): List<Map<String, Any?>> = store().takeEvents()

  /* ----------------------------------------------------------- deep links */

  /** Cold starts deliver the link through the launch intent, before JS can listen. */
  fun pendingPreview(): Map<String, Any?>? = previewCandidate?.let {
    mapOf("d" to it["d"], "s" to it["s"])
  }

  fun handleDeepLink(url: String?): Boolean {
    val uri = runCatching { Uri.parse(url ?: return false) }.getOrNull() ?: return false
    if (uri.host != "ota" || uri.path?.startsWith("/preview") != true) return false
    val d = uri.getQueryParameter("d") ?: return false
    val s = uri.getQueryParameter("s") ?: return false
    return handlePreviewToken(d, s)
  }

  /** Verifies the token from `<scheme>://ota/preview?d&s` (docs/API.md §4.3). */
  fun handlePreviewToken(d: String, s: String): Boolean {
    val config = config()
    val payload = try {
      JSONObject(String(Base64.decode(d, Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8))
    } catch (t: Throwable) {
      throw OtaError(OtaError.PREVIEW_INVALID, "preview payload is malformed", t)
    }

    if (payload.optString("purpose") != "preview") {
      throw OtaError(OtaError.PREVIEW_INVALID, "token is not a preview token")
    }
    if (!SignatureVerifier.verify(CanonicalJson.canonicalize(payload), s, config.publicKey)) {
      throw OtaError(OtaError.PREVIEW_INVALID, "preview signature does not verify")
    }
    if (payload.optString("projectId") != config.projectId) {
      throw OtaError(OtaError.PREVIEW_INVALID, "preview token belongs to another project")
    }
    val exp = payload.optLong("exp")
    if (exp + PREVIEW_CLOCK_SKEW_SECONDS < System.currentTimeMillis() / 1000) {
      throw OtaError(OtaError.PREVIEW_INVALID, "preview token expired")
    }

    previewCandidate = mapOf("d" to d, "s" to s, "releaseId" to payload.optString("releaseId"))
    emit(EVENT_PREVIEW_REQUESTED, mapOf("d" to d, "s" to s))
    return true
  }

  /* --------------------------------------------------------------- internals */

  private fun promotePending(state: UpdateStore.State) {
    val pending = state.pendingReleaseId ?: return
    if (state.currentSlot != state.pendingSlot) {
      state.previousReleaseId = state.currentReleaseId
      state.previousSlot = state.currentSlot
      state.previousLabel = state.currentLabel
    }
    state.currentReleaseId = pending
    state.currentSlot = state.pendingSlot
    state.currentLabel = state.pendingLabel
    state.pendingReleaseId = null
    state.pendingSlot = null
    state.pendingLabel = null
    state.pendingVerification = true
  }

  /** Drops the broken release and falls back one step; the slot itself is left to
   *  be overwritten by the next download (no recursive delete on the boot thread). */
  private fun revert(state: UpdateStore.State, releaseId: String?, reason: String) {
    if (releaseId != null) {
      state.failedReleaseIds.remove(releaseId)
      state.failedReleaseIds.add(releaseId)
      while (state.failedReleaseIds.size > MAX_FAILED) state.failedReleaseIds.removeAt(0)
      queueRollbackEvent(releaseId, state.previousReleaseId, reason)
    }
    state.currentReleaseId = state.previousReleaseId
    state.currentSlot = state.previousSlot
    state.currentLabel = state.previousLabel
    state.previousReleaseId = null
    state.previousSlot = null
    state.previousLabel = null
    state.pendingReleaseId = null
    state.pendingSlot = null
    state.pendingLabel = null
    state.pendingVerification = false
    state.previewReleaseId = null
  }

  private fun queueRollbackEvent(releaseId: String, restored: String?, reason: String) {
    val meta = JSONObject().put("reason", reason)
    if (restored != null) meta.put("from", restored)
    store().appendEvent(
      JSONObject()
        .put("type", "rollback")
        .put("release", releaseId)
        .put("ts", System.currentTimeMillis() / 1000)
        .put("meta", meta),
    )
  }

  /** A new binary always carries a newer floor, so this also clears bundles built
   *  for a runtimeVersion this binary no longer speaks. */
  private fun dropReleasesBelowFloor(state: UpdateStore.State) {
    val floor = config().embeddedFloorId ?: return
    if (state.pendingReleaseId?.let { it <= floor } == true) {
      state.pendingReleaseId = null
      state.pendingSlot = null
      state.pendingLabel = null
    }
    if (state.previousReleaseId?.let { it <= floor } == true) {
      state.previousReleaseId = null
      state.previousSlot = null
      state.previousLabel = null
    }
    if (state.currentReleaseId?.let { it <= floor } == true) {
      state.currentReleaseId = null
      state.currentSlot = null
      state.currentLabel = null
      state.pendingVerification = false
      state.previewReleaseId = null
    }
  }

  private fun resolveCurrent(store: UpdateStore, state: UpdateStore.State): String? {
    val slot = state.currentSlot ?: return null
    if (state.currentReleaseId == null) return null
    return resolveBundle(store.slotDir(slot))?.absolutePath
  }

  /** The zip keeps the `expo export` layout, so the entry point can be either a
   *  plain bundle at the root or the file metadata.json points at. */
  private fun resolveBundle(slotDir: File): File? {
    if (!slotDir.isDirectory) return null
    BUNDLE_NAMES.forEach { name -> File(slotDir, name).takeIf { it.isFile }?.let { return it } }

    val metadata = File(slotDir, "metadata.json")
    if (metadata.isFile) {
      runCatching {
        val relative = JSONObject(metadata.readText())
          .getJSONObject("fileMetadata")
          .getJSONObject(PLATFORM)
          .getString("bundle")
        File(slotDir, relative).takeIf { it.isFile }
      }.getOrNull()?.let { return it }
    }
    return searchBundle(slotDir, 0)
  }

  private fun searchBundle(dir: File, depth: Int): File? {
    if (depth > 6) return null
    val children = dir.listFiles() ?: return null
    children.filter { it.isFile && (it.name.endsWith(".hbc") || it.name.endsWith(".bundle")) }
      .minByOrNull { it.name }
      ?.let { return it }
    for (child in children) {
      if (child.isDirectory && child.name != "assets") {
        searchBundle(child, depth + 1)?.let { return it }
      }
    }
    return null
  }

  /* ------------------------------------------------- react instance plumbing */

  // ponytail: neither ReactInstanceManager nor ReactHost re-reads the bundle path
  // on reload, so the loader is swapped by reflection — same trick CodePush and
  // hot-updater use. If it ever breaks we fall back to applying on the next launch.
  private fun swapBundle(context: Context, path: String?): Boolean {
    val application = context.applicationContext
    if (application !is ReactApplication) return false
    val loader = if (path != null) {
      JSBundleLoader.createFileLoader(path)
    } else {
      JSBundleLoader.createAssetLoader(context, "assets://index.android.bundle", false)
    }

    reactHost(application)?.let { host ->
      val delegate = listOf("mReactHostDelegate", "reactHostDelegate")
        .firstNotNullOfOrNull { name -> readField(host, name) }
      return setField(delegate, "jsBundleLoader", loader)
    }

    val instanceManager =
      runCatching { application.reactNativeHost.reactInstanceManager }.getOrNull()
    return setField(instanceManager, "mBundleLoader", loader)
  }

  private fun triggerReload(context: Context) {
    val application = context.applicationContext
    if (application !is ReactApplication) return
    reactHost(application)?.let { host ->
      val reloaded = runCatching {
        host.javaClass.getMethod("reload", String::class.java).invoke(host, "Open OTA update")
      }.isSuccess
      if (reloaded) return
    }
    runCatching { application.reactNativeHost.reactInstanceManager.recreateReactContextInBackground() }
      .onFailure { Log.e(TAG, "reload failed", it) }
  }

  // Reflection: ReactApplication.getReactHost() only exists on RN 0.74+.
  private fun reactHost(application: Any): Any? =
    runCatching { application.javaClass.getMethod("getReactHost").invoke(application) }.getOrNull()

  private fun readField(target: Any, name: String): Any? = runCatching {
    findField(target.javaClass, name)?.apply { isAccessible = true }?.get(target)
  }.getOrNull()

  private fun setField(target: Any?, name: String, value: Any): Boolean {
    if (target == null) return false
    return runCatching {
      val field = findField(target.javaClass, name) ?: return false
      field.isAccessible = true
      field.set(target, value)
      true
    }.getOrDefault(false)
  }

  private fun findField(type: Class<*>, name: String): Field? {
    var current: Class<*>? = type
    while (current != null) {
      current.declaredFields.firstOrNull { it.name == name }?.let { return it }
      current = current.superclass
    }
    return null
  }

  /* ------------------------------------------------------------------ wiring */

  /**
   * Bridgeless entry point — what the codemod wires into the host's
   * `reactHost` getter. `DefaultReactHost` converts the old-architecture
   * `ReactNativeHost` (whose `getJSBundleFile()` the codemod also overrides to
   * call [getBundleFile]) into a `ReactHost`, so both architectures resolve the
   * bundle through the same boot path. Calling [getBundleFile] first is what
   * runs the crash watchdog before the host is even constructed.
   */
  @JvmStatic
  fun createReactHost(
    context: Context,
    reactNativeHost: com.facebook.react.ReactNativeHost,
  ): com.facebook.react.ReactHost {
    getBundleFile(context)
    return com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost(context, reactNativeHost)
  }

  private fun requireContext(): Context =
    appContext ?: throw OtaError(OtaError.NOT_CONFIGURED, "OpenOta has no application context yet")

  private fun store(): UpdateStore = storeRef
    ?: UpdateStore(requireContext().filesDir).also { storeRef = it }

  private fun config(): OtaConfig = configRef
    ?: OtaConfig.from(requireContext()).also { configRef = it }

  private fun emit(name: String, body: Map<String, Any?>) {
    runCatching { emitter?.invoke(name, body) }
  }
}
