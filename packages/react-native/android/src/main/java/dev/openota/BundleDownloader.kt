package dev.openota

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

internal object BundleDownloader {

  private const val MAX_REDIRECTS = 5
  private const val PROGRESS_INTERVAL_MS = 100L

  /** Streams [url] into [target] and returns the SHA-256 of what landed there. */
  fun download(
    url: String,
    target: File,
    expectedSize: Long,
    maxBytes: Long,
    onProgress: (written: Long, total: Long) -> Unit,
  ): String {
    target.parentFile?.mkdirs()
    val digest = MessageDigest.getInstance("SHA-256")
    var connection = open(url)
    var redirects = 0

    try {
      while (connection.responseCode in 300..399 && redirects < MAX_REDIRECTS) {
        val location = connection.getHeaderField("Location")
          ?: throw OtaError(OtaError.DOWNLOAD_FAILED, "redirect without Location")
        val next = URL(URL(connection.url.toString()), location).toString()
        connection.disconnect()
        connection = open(next)
        redirects++
      }

      if (connection.responseCode !in 200..299) {
        throw OtaError(OtaError.DOWNLOAD_FAILED, "HTTP ${connection.responseCode} for $url")
      }

      val declared = connection.contentLength.toLong()
      val total = if (declared > 0) declared else expectedSize
      var written = 0L
      var lastEmit = 0L

      connection.inputStream.use { input ->
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            written += read
            if (written > maxBytes) {
              throw OtaError(OtaError.DOWNLOAD_FAILED, "bundle exceeds $maxBytes bytes")
            }
            digest.update(buffer, 0, read)
            output.write(buffer, 0, read)

            val now = System.currentTimeMillis()
            if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
              lastEmit = now
              onProgress(written, total)
            }
          }
          output.fd.sync()
        }
      }
      onProgress(written, total)
      return digest.digest().joinToString("") { "%02x".format(it) }
    } catch (e: OtaError) {
      throw e
    } catch (t: Throwable) {
      throw OtaError(OtaError.DOWNLOAD_FAILED, t.message ?: "download failed", t)
    } finally {
      connection.disconnect()
    }
  }

  private fun open(url: String): HttpURLConnection =
    (URL(url).openConnection() as HttpURLConnection).apply {
      // Handled manually: HttpURLConnection refuses to follow http <-> https hops.
      instanceFollowRedirects = false
      connectTimeout = 30_000
      readTimeout = 60_000
      requestMethod = "GET"
      setRequestProperty("Accept-Encoding", "identity")
    }
}
