export type EnvironmentSource = Record<string, string | undefined>;
export type HeaderSource = Record<string, unknown>;

type HeaderValue = string | string[] | undefined;

/**
 * The only Stage 0 compatibility seam for old Anomalo identifiers. // naming-compat
 *
 * Canonical values always win. Legacy values are read only when the canonical
 * value is absent, and the adapter records a low-cardinality counter without
 * retaining secrets or caller-provided values.
 */
export class LegacyNamingAdapter {
  private readonly legacyReads = new Map<string, number>();

  readEnv(source: EnvironmentSource, canonicalName: string): string | undefined {
    const canonical = source[canonicalName];
    if (canonical !== undefined) return canonical;
    const legacyName = legacyEnvironmentName(canonicalName);
    if (!legacyName) return undefined;
    const legacy = source[legacyName];
    if (legacy === undefined) return undefined;
    this.record(`env:${canonicalName}`);
    return legacy;
  }

  readHeader(source: HeaderSource, canonicalName: string): string | undefined {
    const canonical = findHeader(source, canonicalName);
    if (canonical !== undefined) return canonical;
    const legacyName = legacyHeaderName(canonicalName);
    if (!legacyName) return undefined;
    const legacy = findHeader(source, legacyName);
    if (legacy === undefined) return undefined;
    this.record(`header:${canonicalName}`);
    return legacy;
  }

  stats(): Record<string, number> {
    return Object.fromEntries(this.legacyReads.entries());
  }

  reset(): void {
    this.legacyReads.clear();
  }

  private record(key: string): void {
    this.legacyReads.set(key, (this.legacyReads.get(key) ?? 0) + 1);
  }
}

export const legacyNamingAdapter = new LegacyNamingAdapter();

export function canonicalizeEnvironmentName(value: string): string {
  return value.startsWith("ANOMALO_") // naming-compat
    ? `ANOMALOHARIS_${value.slice("ANOMALO_".length)}` // naming-compat
    : value;
}

export function canonicalizePresetModelRef(value: string): string {
  return value.replace(/^anomalo@([1-9][0-9]*)$/, "anomaloharis@$1"); // naming-compat
}

export function canonicalizePresetModelName(value: string): string {
  return value === "anomalo" ? "anomaloharis" : value; // naming-compat
}

function legacyEnvironmentName(canonicalName: string): string | undefined {
  return canonicalName.startsWith("ANOMALOHARIS_")
    ? `ANOMALO_${canonicalName.slice("ANOMALOHARIS_".length)}` // naming-compat
    : undefined;
}

function legacyHeaderName(canonicalName: string): string | undefined {
  const lower = canonicalName.toLowerCase();
  return lower.startsWith("x-anomaloharis-")
    ? `x-anomalo-${lower.slice("x-anomaloharis-".length)}` // naming-compat
    : undefined;
}

function findHeader(source: HeaderSource, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(source).find(([key]) => key.toLowerCase() === wanted);
  if (!entry) return undefined;
  const value = entry[1] as HeaderValue;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}
