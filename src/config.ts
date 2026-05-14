export const APP_VERSION = '3.0.1';
export const BEAR_URL_SCHEME = 'bear://x-callback-url/';
export const CORE_DATA_EPOCH_OFFSET = 978307200; // 2001-01-01 to Unix epoch
export const DEFAULT_SEARCH_LIMIT = 30;
// Schema-level ceiling on bear-search-notes. The IN-clause in
// fetchRevisionsForResults binds one placeholder per result, so the worst-case
// parameter count for a single query equals this cap. 1000 sits well under
// SQLite's bound-parameter limit (32766 since 3.32.0) and is generous compared
// to realistic LLM-driven use (default 30, median user ask ≤ 100); a schema-
// level cap fails clearly at the tool boundary rather than as an opaque
// "too many SQL variables" error from inside the handler.
export const MAX_SEARCH_LIMIT = 1000;

export const BEAR_DATABASE_PATH =
  'Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite';

export const ENABLE_NEW_NOTE_CONVENTIONS = process.env.UI_ENABLE_NEW_NOTE_CONVENTION === 'true';
export const ENABLE_CONTENT_REPLACEMENT = process.env.UI_ENABLE_CONTENT_REPLACEMENT === 'true';

export const ERROR_MESSAGES = {
  BEAR_DATABASE_NOT_FOUND:
    'Bear database not found. Please ensure Bear Notes is installed and has been opened at least once.',
} as const;
