/**
 * Explicit translator bootstrap module.
 * Importing this file initializes all translator adapters via side-effect registration.
 */

import "./request/openai-responses.ts";

import "./response/openai-responses.ts";

export function bootstrapTranslatorRegistry() {
  // no-op by design; importing this module triggers translator self-registration once
}
