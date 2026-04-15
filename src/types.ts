/**
 * Represents a Bear note with metadata and optional content.
 * Fields match Bear's internal database structure for consistency.
 */
export interface AttachedFile {
  filename: string;
  content: string;
}

export interface BearNote {
  title: string;
  identifier: string;
  modification_date: string;
  creation_date: string;
  pin: 'yes' | 'no';
  tags?: string[]; // Only present in search results
  text?: string; // Only present in content queries
  files?: AttachedFile[]; // Only present in getNoteContent()
}

/**
 * Lightweight note match for title-based lookups where full content is not needed.
 * Used for disambiguation when multiple notes share the same title.
 */
export interface NoteTitleMatch {
  identifier: string;
  title: string;
  modification_date: string;
}

/**
 * Date filter parameters for searching notes by creation or modification date.
 */
export interface DateFilter {
  createdAfter?: string;
  createdBefore?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
}

/**
 * Represents a Bear tag with hierarchy support.
 * Tags form a tree structure where nested tags like "career/content/blog"
 * become children of their parent tags.
 */
export interface BearTag {
  name: string; // Full path: "career/content/blog"
  displayName: string; // Leaf name only: "blog"
  noteCount: number;
  children: BearTag[];
}
