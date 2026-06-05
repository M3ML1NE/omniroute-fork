export { APP_CONFIG, THEME_CONFIG } from "./appConfig";

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

// Provider API endpoints (for display only)
export const PROVIDER_ENDPOINTS = {
  gigachat: "https://gigachat.devices.sberbank.ru/api/v1/chat/completions",
};

// Re-export from providers.js for backward compatibility
export {
  NOAUTH_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  SEARCH_PROVIDERS,
  AUDIO_ONLY_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers";

// Re-export from models.js for backward compatibility
export { PROVIDER_MODELS, AI_MODELS } from "./models";
