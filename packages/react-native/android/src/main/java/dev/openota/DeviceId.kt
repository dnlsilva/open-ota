package dev.openota

import java.util.UUID

/**
 * Anonymous install id: random, persisted with the rest of the state, gone on
 * reinstall. No hardware identifiers — nothing here should survive a wipe.
 */
internal object DeviceId {
  fun getOrCreate(store: UpdateStore): String =
    store.state.deviceId ?: UUID.randomUUID().toString().also {
      store.state.deviceId = it
      store.write()
    }
}
