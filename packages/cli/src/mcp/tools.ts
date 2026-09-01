/**
 * The tool contract now lives in @open-ota/shared, so the stdio server here and
 * the /mcp route on the server cannot drift apart. This file only re-exports it
 * — importing from here or from the shared package gives the same objects.
 */

export {
  otaToolByName,
  otaTools,
  otaToolShapes,
  parseToolInput,
  toolSchema,
  type OtaToolDefinition,
  type OtaToolInput,
  type OtaToolName,
} from "@open-ota/shared";
