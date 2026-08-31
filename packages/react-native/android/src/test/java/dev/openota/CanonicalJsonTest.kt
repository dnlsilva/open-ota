package dev.openota

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Vectors produced by packages/shared/src/canonical.ts. If one of these fails,
 * every signature this SDK verifies is verifying different bytes than the server
 * signed.
 */
class CanonicalJsonTest {

  @Test
  fun `manifest keys are sorted and whitespace free`() {
    val received = """
      {"id":"0193a4c8-0000-7000-8000-000000000001","projectId":"prj_x","platform":"android",
       "channel":"production","runtimeVersion":"fp_9f8e7d","label":42,
       "sha256":"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
       "size":4812345,"createdAt":"2026-09-01T12:00:00Z"}
    """.trimIndent()

    assertEquals(
      "{\"channel\":\"production\",\"createdAt\":\"2026-09-01T12:00:00Z\"," +
        "\"id\":\"0193a4c8-0000-7000-8000-000000000001\",\"label\":42,\"platform\":\"android\"," +
        "\"projectId\":\"prj_x\",\"runtimeVersion\":\"fp_9f8e7d\"," +
        "\"sha256\":\"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9\"," +
        "\"size\":4812345}",
      CanonicalJson.canonicalize(JSONObject(received)),
    )
  }

  @Test
  fun `preview token payload`() {
    val received =
      """{"purpose":"preview","projectId":"prj_x","releaseId":"0193a4c8-0000-7000-8000-000000000001","exp":1756732500}"""
    assertEquals(
      "{\"exp\":1756732500,\"projectId\":\"prj_x\",\"purpose\":\"preview\"," +
        "\"releaseId\":\"0193a4c8-0000-7000-8000-000000000001\"}",
      CanonicalJson.canonicalize(JSONObject(received)),
    )
  }

  @Test
  fun `escaping and key order match JSON stringify`() {
    val value = JSONObject()
      .put("z", "q\" b\\ n\n t\t c\u0001 ")
      .put("a\u00e9", "emoji \uD83D\uDE00 lone \uD800")
      .put("b", JSONArray(listOf(1, -0.0, true, JSONObject.NULL, 3.5)))
      .put("Z", "upper")
      .put("", "empty")

    assertEquals(
      "{\"\":\"empty\",\"Z\":\"upper\",\"a\u00e9\":\"emoji \uD83D\uDE00 lone \\ud800\"," +
        "\"b\":[1,0,true,null,3.5],\"z\":\"q\\\" b\\\\ n\\n t\\t c\\u0001 \"}",
      CanonicalJson.canonicalize(value),
    )
  }
}
