import ExpoModulesCore

public class OpenOtaModule: Module {

  public func definition() -> ModuleDefinition {
    Name("OpenOta")

    Events(
      OpenOta.downloadProgressEvent,
      OpenOta.updateStateEvent,
      OpenOta.previewRequestedEvent
    )

    Constants { OpenOta.constants() }

    OnCreate {
      OpenOta.emitter = { [weak self] name, body in self?.sendEvent(name, body) }
      OpenOta.startObservingLinks()
    }

    OnDestroy {
      OpenOta.emitter = nil
      OpenOta.stopObservingLinks()
    }

    Function("getStatus") { withNulls(OpenOta.status()) }

    Function("getPendingPreview") { OpenOta.pendingPreview() }

    Function("setChannel") { (channel: String?) in OpenOta.setChannel(channel) }

    Function("clearFailed") { OpenOta.clearFailed() }

    AsyncFunction("downloadUpdate") { (manifestJson: String, signatureBase64: String, url: String, promise: Promise) in
      OpenOta.downloadUpdate(
        manifestJson: manifestJson,
        signatureBase64: signatureBase64,
        url: url,
        onProgress: { [weak self] written, total in
          self?.sendEvent(OpenOta.downloadProgressEvent, ["written": written, "total": total])
        }
      ) { result in
        switch result {
        case .success(let value): promise.resolve(value)
        case .failure(let error): reject(promise, error)
        }
      }
    }

    AsyncFunction("applyUpdate") { (reload: Bool, promise: Promise) in
      do {
        try OpenOta.applyUpdate(reloadNow: reload)
        promise.resolve(nil)
      } catch {
        reject(promise, error)
      }
    }

    AsyncFunction("notifyAppReady") { (promise: Promise) in
      OpenOta.notifyAppReady()
      promise.resolve(nil)
    }

    AsyncFunction("reload") { (promise: Promise) in
      OpenOta.reload()
      promise.resolve(nil)
    }

    AsyncFunction("rollback") { (reason: String, promise: Promise) in
      OpenOta.rollback(reason: reason)
      promise.resolve(nil)
    }

    AsyncFunction("exitPreview") { (promise: Promise) in
      OpenOta.exitPreview()
      promise.resolve(nil)
    }

    AsyncFunction("takePendingEvents") { (promise: Promise) in
      promise.resolve(OpenOta.takePendingEvents())
    }

    AsyncFunction("handlePreviewLink") { (url: String, promise: Promise) in
      do {
        promise.resolve(try OpenOta.handleDeepLink(url))
      } catch {
        reject(promise, error)
      }
    }
  }
}

/// Every failure reaches JS as a typed code instead of an opaque exception.
private func reject(_ promise: Promise, _ error: Error) {
  if let error = error as? OtaError {
    promise.reject(error.code, error.message)
  } else {
    promise.reject("ERR_OTA_UNKNOWN", error.localizedDescription)
  }
}

/// JS expects explicit nulls where the SDK has no value.
private func withNulls(_ values: [String: Any?]) -> [String: Any] {
  values.mapValues { $0 ?? NSNull() }
}
