import { OpenOta as core } from "./OpenOta.js";
import { OtaProvider, wrap } from "./provider.js";

/** `OpenOta.wrap(App)` lives here so OpenOta.ts stays free of React. */
export const OpenOta = Object.assign(core, { wrap });
export default OpenOta;

export { OtaProvider, wrap };
export { configure, buildUpdateCheckUrl, planFrom, updateCheckHeaders } from "./OpenOta.js";
export type { AvailableUpdate, OtaOptions, SyncPlan, UpdateCheckParams } from "./OpenOta.js";
export { EventQueue, flushOnBackground } from "./events.js";
export type { EventQueueOptions, KeyValueStore } from "./events.js";
export { handlePreviewRequest, installPreviewHandler, parsePreviewLink } from "./preview.js";
export type { PreviewFailure, PreviewResult } from "./preview.js";
export { setNativeModule, isNativeModuleAvailable } from "./native.js";
export type { OpenOtaNativeModule, OtaConstants } from "./native.js";
export { SDK_VERSION } from "./version.js";
export type { OtaProviderProps } from "./provider.js";
export type * from "./types.js";
