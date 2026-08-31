package dev.openota

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

internal object Unzipper {

  /** Extracts [zip] into [target], refusing entries that would land outside it. */
  fun unzip(zip: File, target: File, maxBytes: Long) {
    target.deleteRecursively()
    target.mkdirs()
    val root = target.canonicalFile
    var written = 0L
    val buffer = ByteArray(64 * 1024)

    ZipInputStream(BufferedInputStream(FileInputStream(zip))).use { zis ->
      while (true) {
        val entry = zis.nextEntry ?: break
        val name = entry.name.replace('\\', '/')
        if (name.startsWith("/") || name.split('/').any { it == ".." }) {
          throw OtaError(OtaError.EXTRACT_FAILED, "zip entry escapes the slot: ${entry.name}")
        }

        val out = File(root, name).canonicalFile
        if (out != root && !out.path.startsWith(root.path + File.separator)) {
          throw OtaError(OtaError.EXTRACT_FAILED, "zip entry escapes the slot: ${entry.name}")
        }

        if (entry.isDirectory) {
          out.mkdirs()
        } else {
          out.parentFile?.mkdirs()
          FileOutputStream(out).use { fos ->
            while (true) {
              val read = zis.read(buffer)
              if (read <= 0) break
              written += read
              if (written > maxBytes) {
                throw OtaError(OtaError.EXTRACT_FAILED, "bundle exceeds $maxBytes bytes")
              }
              fos.write(buffer, 0, read)
            }
          }
        }
        zis.closeEntry()
      }
    }
  }
}
