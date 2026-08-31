package dev.openota

import android.util.Base64
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** RSA-2048 / SHA-256 detached signatures over canonical JSON (docs/API.md §4.2). */
internal object SignatureVerifier {

  fun verify(canonical: String, signatureBase64: String, publicKeyPem: String): Boolean = try {
    Signature.getInstance("SHA256withRSA").run {
      initVerify(publicKey(publicKeyPem))
      update(canonical.toByteArray(Charsets.UTF_8))
      verify(decode(signatureBase64))
    }
  } catch (t: Throwable) {
    false
  }

  private fun publicKey(pem: String): PublicKey {
    val der = decode(pem)
    return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der))
  }

  /** Tolerates PEM armor, wrapped lines and base64url — the plugin bakes the key
   *  into AndroidManifest meta-data, where newlines survive inconsistently. */
  private fun decode(text: String): ByteArray {
    val body = text
      .replace(Regex("-----[A-Z ]+-----"), "")
      .replace('-', '+')
      .replace('_', '/')
      .filter { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' }
    return Base64.decode(body, Base64.DEFAULT)
  }
}
