import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";

export type WebSessionCredentialRequirement =
  | {
      kind: "cookie" | "token";
      credentialName: string;
      placeholder: string;
      acceptsFullCookieHeader: boolean;
    }
  | {
      kind: "none";
      credentialName: "";
      placeholder: "";
      acceptsFullCookieHeader: false;
    };

export const WEB_SESSION_CREDENTIAL_REQUIREMENTS = {} satisfies Record<
  keyof typeof WEB_COOKIE_PROVIDERS,
  WebSessionCredentialRequirement
>;

export function getWebSessionCredentialRequirement(
  providerId: unknown
): WebSessionCredentialRequirement | null {
  if (typeof providerId !== "string") return null;
  return (
    WEB_SESSION_CREDENTIAL_REQUIREMENTS[
      providerId as keyof typeof WEB_SESSION_CREDENTIAL_REQUIREMENTS
    ] ?? null
  );
}

export function requiresWebSessionCredential(providerId: unknown): boolean {
  const requirement = getWebSessionCredentialRequirement(providerId);
  return !!requirement && requirement.kind !== "none";
}
