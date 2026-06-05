/**
 * Explicit translator bootstrap module.
 * Importing this file initializes all translator adapters via side-effect registration.
 */

import "./request/gemini-to-openai.ts";
import "./request/openai-to-gemini.ts";
import "./request/antigravity-to-openai.ts";
import "./request/openai-responses.ts";
import "./request/openai-to-kiro.ts";
import "./request/openai-to-cursor.ts";

import "./response/gemini-to-openai.ts";
import "./response/openai-to-antigravity.ts";
import "./response/openai-responses.ts";
import "./response/kiro-to-openai.ts";
import "./response/cursor-to-openai.ts";

export function bootstrapTranslatorRegistry() {
  // no-op by design; importing this module triggers translator self-registration once
}
