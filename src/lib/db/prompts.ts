/**
 * Prompt Template Versioning — L-6
 *
 * Postgres-backed prompt template storage with version tracking.
 * Each prompt has a unique `slug`, and every save creates a new version
 * (content-addressed via SHA-256 hash). Previous versions are retained
 * for rollback and audit.
 *
 * Schema is owned by the baseline migration (prompt_templates table).
 *
 * @module lib/db/prompts
 */

import crypto from "crypto";
import { getDbInstance, withTransaction } from "./core";

interface PromptRow {
  id: unknown;
  slug: unknown;
  version: unknown;
  content: unknown;
  content_hash: unknown;
  variables: unknown;
  description: unknown;
  is_active: unknown;
  created_at: unknown;
}

interface PromptListRow {
  slug: unknown;
  active_version: unknown;
  total_versions: unknown;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number"
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : fallback;
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseVariables(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Public API ──

export interface PromptTemplate {
  id: number;
  slug: string;
  version: number;
  content: string;
  contentHash: string;
  variables: string[] | null;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}

/**
 * Save a prompt template. If the slug already exists and the content
 * has changed, a new version is created. If content is identical,
 * returns the existing version without duplicating.
 */
export async function savePrompt(
  slug: string,
  content: string,
  options: { variables?: string[]; description?: string } = {}
): Promise<PromptTemplate> {
  const db = getDbInstance();
  const hash = hashContent(content);

  // Check if identical content already exists for this slug
  const existing = (await db
    .prepare(
      "SELECT * FROM prompt_templates WHERE slug = ? AND content_hash = ?"
    )
    .get(slug, hash)) as PromptRow | undefined;


  if (existing) {
    return rowToPrompt(existing);
  }

  return withTransaction(async (client) => {
    // Deactivate previous active version
    await client.query(
      "UPDATE prompt_templates SET is_active = 0 WHERE slug = $1 AND is_active = 1",
      [slug]
    );

    // Get next version number
    const maxRes = await client.query<{ max_v: string | null }>(
      "SELECT MAX(version) as max_v FROM prompt_templates WHERE slug = $1",
      [slug]
    );
    const nextVersion = toNumber(maxRes.rows[0]?.max_v, 0) + 1;

    // Insert new version
    const insertRes = await client.query<{ id: unknown }>(
      `INSERT INTO prompt_templates (slug, version, content, content_hash, variables, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id`,
      [
        slug,
        nextVersion,
        content,
        hash,
        options.variables ? JSON.stringify(options.variables) : null,
        options.description || null,
      ]
    );

    return {
      id: toNumber(insertRes.rows[0]?.id, 0),
      slug,
      version: nextVersion,
      content,
      contentHash: hash,
      variables: options.variables || null,
      description: options.description || null,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * Get the active (latest) version of a prompt by slug.
 */
export async function getActivePrompt(slug: string): Promise<PromptTemplate | null> {
  const db = getDbInstance();
  const row = (await db
    .prepare(
      "SELECT * FROM prompt_templates WHERE slug = ? AND is_active = 1"
    )
    .get(slug)) as PromptRow | undefined;
  return row ? rowToPrompt(row) : null;
}

/**
 * Get a specific version of a prompt.
 */
export async function getPromptVersion(
  slug: string,
  version: number
): Promise<PromptTemplate | null> {
  const db = getDbInstance();
  const row = (await db
    .prepare(
      "SELECT * FROM prompt_templates WHERE slug = ? AND version = ?"
    )
    .get(slug, version)) as PromptRow | undefined;
  return row ? rowToPrompt(row) : null;
}

/**
 * List all versions of a prompt (newest first).
 */
export async function listPromptVersions(slug: string): Promise<PromptTemplate[]> {
  const db = getDbInstance();
  const rows = (await db
    .prepare(
      "SELECT * FROM prompt_templates WHERE slug = ? ORDER BY version DESC"
    )
    .all(slug)) as PromptRow[];
  return rows.map(rowToPrompt);
}

/**
 * List all prompt slugs with their active version info.
 */
export async function listPrompts(): Promise<
  Array<{
    slug: string;
    activeVersion: number;
    totalVersions: number;
  }>
> {
  const db = getDbInstance();
  const rows = (await db
    .prepare(
      `SELECT slug,
              MAX(CASE WHEN is_active = true THEN version ELSE 0 END) as active_version,
              COUNT(*) as total_versions
       FROM prompt_templates
       GROUP BY slug
       ORDER BY slug`
    )
    .all()) as PromptListRow[];

  return rows.map((r) => ({
    slug: toString(r.slug),
    activeVersion: toNumber(r.active_version, 0),
    totalVersions: toNumber(r.total_versions, 0),
  }));
}

/**
 * Rollback to a previous version (makes it the active one).
 */
export async function rollbackPrompt(
  slug: string,
  version: number
): Promise<PromptTemplate | null> {
  const db = getDbInstance();

  const target = (await db
    .prepare(
      "SELECT * FROM prompt_templates WHERE slug = ? AND version = ?"
    )
    .get(slug, version)) as PromptRow | undefined;

  if (!target) return null;

  await withTransaction(async (client) => {
    await client.query(
      "UPDATE prompt_templates SET is_active = false WHERE slug = $1",
      [slug]
    );
    await client.query(
      "UPDATE prompt_templates SET is_active = true WHERE slug = $1 AND version = $2",
      [slug, version]
    );
  });

  return rowToPrompt({ ...target, is_active: true } as PromptRow);
}

/**
 * Render a prompt template by substituting variables.
 */
export async function renderPrompt(
  slug: string,
  vars: Record<string, string> = {}
): Promise<string | null> {
  const prompt = await getActivePrompt(slug);
  if (!prompt) return null;

  let content = prompt.content;
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return content;
}

// ── Internal ──

function rowToPrompt(row: PromptRow): PromptTemplate {
  return {
    id: toNumber(row.id, 0),
    slug: toString(row.slug),
    version: toNumber(row.version, 1),
    content: toString(row.content),
    contentHash: toString(row.content_hash),
    variables: parseVariables(row.variables),
    description: typeof row.description === "string" ? row.description : null,
    isActive: row.is_active === 1 || row.is_active === true,
    createdAt: toString(row.created_at),
  };
}
