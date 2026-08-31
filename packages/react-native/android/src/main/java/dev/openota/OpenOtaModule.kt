package dev.openota

import android.content.Context
import android.content.Intent
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OpenOtaModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OpenOta")

    Events(
      OpenOta.EVENT_DOWNLOAD_PROGRESS,
      OpenOta.EVENT_UPDATE_STATE,
      OpenOta.EVENT_PREVIEW_REQUESTED,
    )

    Constants { OpenOta.constants(context) }

    OnCreate {
      OpenOta.attach(context)
      OpenOta.emitter = { name, body -> this@OpenOtaModule.sendEvent(name, body) }
      // A cold start opened by the deep link already consumed the intent.
      appContext.currentActivity?.intent?.let { runCatching { handleIntent(it) } }
    }

    OnDestroy { OpenOta.emitter = null }

    OnNewIntent { intent -> runCatching { handleIntent(intent) } }

    Function("getStatus") { OpenOta.status() }

    Function("getPendingPreview") { OpenOta.pendingPreview() }

    Function("setChannel") { channel: String? -> OpenOta.setChannel(channel) }

    Function("clearFailed") { OpenOta.clearFailed() }

    AsyncFunction("downloadUpdate") { manifestJson: String, signatureBase64: String, url: String, promise: Promise ->
      guard(promise) { OpenOta.downloadUpdate(manifestJson, signatureBase64, url) }
    }

    AsyncFunction("applyUpdate") { reload: Boolean, promise: Promise ->
      guard(promise) { OpenOta.applyUpdate(reload); null }
    }

    AsyncFunction("notifyAppReady") { promise: Promise ->
      guard(promise) { OpenOta.notifyAppReady(); null }
    }

    AsyncFunction("reload") { promise: Promise ->
      guard(promise) { OpenOta.reload(); null }
    }

    AsyncFunction("rollback") { reason: String, promise: Promise ->
      guard(promise) { OpenOta.rollback(reason); null }
    }

    AsyncFunction("exitPreview") { promise: Promise ->
      guard(promise) { OpenOta.exitPreview(); null }
    }

    AsyncFunction("takePendingEvents") { promise: Promise ->
      guard(promise) { OpenOta.takePendingEvents() }
    }

    AsyncFunction("handlePreviewLink") { url: String, promise: Promise ->
      guard(promise) { OpenOta.handleDeepLink(url) }
    }
  }

  private fun handleIntent(intent: Intent) {
    if (intent.action == Intent.ACTION_VIEW) OpenOta.handleDeepLink(intent.data?.toString())
  }

  /** Every failure reaches JS as a typed code instead of an opaque exception. */
  private inline fun guard(promise: Promise, body: () -> Any?) {
    try {
      promise.resolve(body())
    } catch (e: OtaError) {
      promise.reject(e.code, e.message, e)
    } catch (t: Throwable) {
      promise.reject("ERR_OTA_UNKNOWN", t.message ?: t.javaClass.simpleName, t)
    }
  }
}
