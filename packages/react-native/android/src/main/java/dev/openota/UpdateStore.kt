package dev.openota

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * <app-data>/open-ota/
 *   slots/A, slots/B   extracted bundles (the `expo export` layout, preserved)
 *   state.json         which slot is what
 *   events.jsonl       events produced natively (rollbacks), drained by JS
 *   tmp/               in-flight downloads
 *
 * Every write goes through a temp file + rename: a half-written state.json read
 * at boot would be indistinguishable from "no update installed" and would strand
 * the device on the embedded bundle.
 */
internal class UpdateStore(root: File) {

  data class State(
    var currentReleaseId: String? = null,
    var currentSlot: String? = null,
    var currentLabel: Int? = null,
    var previousReleaseId: String? = null,
    var previousSlot: String? = null,
    var previousLabel: Int? = null,
    var pendingReleaseId: String? = null,
    var pendingSlot: String? = null,
    var pendingLabel: Int? = null,
    var pendingVerification: Boolean = false,
    var failedReleaseIds: MutableList<String> = mutableListOf(),
    var previewReleaseId: String? = null,
    var deviceId: String? = null,
    var channelOverride: String? = null,
  ) {
    fun snapshot(): State = copy(failedReleaseIds = failedReleaseIds.toMutableList())
  }

  val dir: File = File(root, "open-ota")
  private val stateFile = File(dir, "state.json")
  private val eventsFile = File(dir, "events.jsonl")
  val tmpDir: File = File(dir, "tmp")

  val state: State by lazy { read() }

  fun slotDir(slot: String): File = File(File(dir, "slots"), slot)

  /** The slot not backing the running bundle. Whatever lived there is forfeit. */
  fun freeSlot(): String = if (state.currentSlot == SLOT_A) SLOT_B else SLOT_A

  fun write(value: State = state) {
    dir.mkdirs()
    val json = JSONObject()
      .putOpt("currentReleaseId", value.currentReleaseId)
      .putOpt("currentSlot", value.currentSlot)
      .putOpt("currentLabel", value.currentLabel)
      .putOpt("previousReleaseId", value.previousReleaseId)
      .putOpt("previousSlot", value.previousSlot)
      .putOpt("previousLabel", value.previousLabel)
      .putOpt("pendingReleaseId", value.pendingReleaseId)
      .putOpt("pendingSlot", value.pendingSlot)
      .putOpt("pendingLabel", value.pendingLabel)
      .put("pendingVerification", value.pendingVerification)
      .put("failedReleaseIds", JSONArray(value.failedReleaseIds))
      .putOpt("previewReleaseId", value.previewReleaseId)
      .putOpt("deviceId", value.deviceId)
      .putOpt("channelOverride", value.channelOverride)

    val tmp = File(dir, "state.json.tmp")
    FileOutputStream(tmp).use {
      it.write(json.toString().toByteArray(Charsets.UTF_8))
      it.fd.sync()
    }
    if (!tmp.renameTo(stateFile)) {
      tmp.delete()
      throw OtaError(OtaError.STATE_WRITE_FAILED, "could not persist ${stateFile.path}")
    }
  }

  /** Replaces the in-memory state in place — callers hold a reference to it. */
  fun restore(snapshot: State) {
    state.apply {
      currentReleaseId = snapshot.currentReleaseId
      currentSlot = snapshot.currentSlot
      currentLabel = snapshot.currentLabel
      previousReleaseId = snapshot.previousReleaseId
      previousSlot = snapshot.previousSlot
      previousLabel = snapshot.previousLabel
      pendingReleaseId = snapshot.pendingReleaseId
      pendingSlot = snapshot.pendingSlot
      pendingLabel = snapshot.pendingLabel
      pendingVerification = snapshot.pendingVerification
      failedReleaseIds = snapshot.failedReleaseIds.toMutableList()
      previewReleaseId = snapshot.previewReleaseId
      deviceId = snapshot.deviceId
      channelOverride = snapshot.channelOverride
    }
    write()
  }

  private fun read(): State {
    val raw = runCatching { stateFile.readText() }.getOrNull() ?: return State()
    val json = runCatching { JSONObject(raw) }.getOrNull() ?: return State()
    val failed = json.optJSONArray("failedReleaseIds")
    return State(
      currentReleaseId = json.str("currentReleaseId"),
      currentSlot = json.str("currentSlot"),
      currentLabel = json.int("currentLabel"),
      previousReleaseId = json.str("previousReleaseId"),
      previousSlot = json.str("previousSlot"),
      previousLabel = json.int("previousLabel"),
      pendingReleaseId = json.str("pendingReleaseId"),
      pendingSlot = json.str("pendingSlot"),
      pendingLabel = json.int("pendingLabel"),
      pendingVerification = json.optBoolean("pendingVerification", false),
      failedReleaseIds = MutableList(failed?.length() ?: 0) { failed!!.optString(it) },
      previewReleaseId = json.str("previewReleaseId"),
      deviceId = json.str("deviceId"),
      channelOverride = json.str("channelOverride"),
    )
  }

  /* -------------------------------------------------------------- telemetry */

  /** Natively generated events (crash rollbacks) outlive the process that saw them. */
  fun appendEvent(event: JSONObject) {
    runCatching {
      dir.mkdirs()
      FileOutputStream(eventsFile, true).use {
        it.write((event.toString() + "\n").toByteArray(Charsets.UTF_8))
        it.fd.sync()
      }
    }
  }

  // ponytail: read-then-delete, so a crash between the two loses a counter.
  // These are operational counters, not billing.
  fun takeEvents(): List<Map<String, Any?>> {
    val text = runCatching { eventsFile.readText() }.getOrNull() ?: return emptyList()
    eventsFile.delete()
    return text.lineSequence()
      .filter { it.isNotBlank() }
      .mapNotNull { line -> runCatching { JSONObject(line).toMap() }.getOrNull() }
      .toList()
  }

  companion object {
    const val SLOT_A = "A"
    const val SLOT_B = "B"

    private fun JSONObject.str(key: String): String? =
      if (isNull(key)) null else optString(key).ifEmpty { null }

    private fun JSONObject.int(key: String): Int? = if (isNull(key)) null else optInt(key)

    private fun JSONObject.toMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
      when (val v = get(key)) {
        is JSONObject -> v.toMap()
        JSONObject.NULL -> null
        else -> v
      }
    }
  }
}

/** Typed failures; the code travels to JS as the promise rejection code. */
internal class OtaError(val code: String, message: String, cause: Throwable? = null) :
  Exception(message, cause) {
  companion object {
    const val NOT_CONFIGURED = "ERR_OTA_NOT_CONFIGURED"
    const val SIGNATURE_INVALID = "ERR_OTA_SIGNATURE_INVALID"
    const val MANIFEST_MISMATCH = "ERR_OTA_MANIFEST_MISMATCH"
    const val DOWNLOAD_FAILED = "ERR_OTA_DOWNLOAD_FAILED"
    const val HASH_MISMATCH = "ERR_OTA_HASH_MISMATCH"
    const val EXTRACT_FAILED = "ERR_OTA_EXTRACT_FAILED"
    const val NOTHING_PENDING = "ERR_OTA_NOTHING_PENDING"
    const val RELOAD_UNSUPPORTED = "ERR_OTA_RELOAD_UNSUPPORTED"
    const val STATE_WRITE_FAILED = "ERR_OTA_STATE_WRITE_FAILED"
    const val PREVIEW_INVALID = "ERR_OTA_PREVIEW_INVALID"
  }
}
