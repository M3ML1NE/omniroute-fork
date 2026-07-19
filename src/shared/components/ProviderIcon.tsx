"use client";

/**
 * ProviderIcon — Renders a provider logo with static asset fallbacks.
 *
 * Strategy:
 * 1. Fall back to /providers/{id}.png (existing static assets — currently only the
 *    generic `oai-cc`/`oai-r` compatible-connection icons)
 * 2. Fall back to /providers/{id}.svg (SVG assets)
 * 3. Fall back to a generic AI icon
 *
 * Usage:
 *   <ProviderIcon providerId="oai-cc" size={24} />
 *   <ProviderIcon providerId="oai-r" size={28} type="color" />
 */

import { memo, useState } from "react";
import Image from "next/image";

interface ProviderIconProps {
  providerId: string;
  size?: number;
  type?: "mono" | "color";
  className?: string;
  style?: React.CSSProperties;
}

function GenericProviderIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const KNOWN_PNGS = new Set(["oai-cc", "oai-r"]);
const KNOWN_SVGS = new Set<string>([]);

const ProviderIcon = memo(function ProviderIcon({
  providerId,
  size = 24,
  type = "color",
  className,
  style,
}: ProviderIconProps) {
  const normalizedId = providerId.toLowerCase();
  const hasPng = KNOWN_PNGS.has(normalizedId);
  const hasSvg = KNOWN_SVGS.has(normalizedId);

  const [failedAssets, setFailedAssets] = useState<Record<string, true>>({});
  const pngKey = `${normalizedId}:png`;
  const svgKey = `${normalizedId}:svg`;
  const usePng = hasPng && !failedAssets[pngKey];
  const useSvg = hasSvg && !failedAssets[svgKey] && (!hasPng || failedAssets[pngKey]);

  if (usePng) {
    return (
      <span
        className={className}
        style={{ display: "inline-flex", alignItems: "center", ...style }}
      >
        <Image
          src={`/providers/${normalizedId}.png`}
          alt={providerId}
          width={size}
          height={size}
          style={{ objectFit: "contain" }}
          onError={() => {
            setFailedAssets((current) => ({ ...current, [pngKey]: true }));
          }}
          unoptimized
        />
      </span>
    );
  }

  if (useSvg) {
    return (
      <span
        className={className}
        style={{ display: "inline-flex", alignItems: "center", ...style }}
      >
        <Image
          src={`/providers/${normalizedId}.svg`}
          alt={providerId}
          width={size}
          height={size}
          style={{ objectFit: "contain" }}
          onError={() => setFailedAssets((current) => ({ ...current, [svgKey]: true }))}
          unoptimized
        />
      </span>
    );
  }

  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", ...style }}>
      <GenericProviderIcon size={size} />
    </span>
  );
});

export default ProviderIcon;
export type { ProviderIconProps };
