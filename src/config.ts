export const APP_VERSION = '3.0.1';
export const BEAR_URL_SCHEME = 'bear://x-callback-url/';
export const CORE_DATA_EPOCH_OFFSET = 978307200; // 2001-01-01 to Unix epoch
export const DEFAULT_SEARCH_LIMIT = 30;
// Caps the IN-clause in fetchRevisionsForResults (one placeholder per result).
// Well below SQLite's 32766 bound-parameter limit; schema-level rejection
// beats an opaque "too many SQL variables" error from the handler.
export const MAX_SEARCH_LIMIT = 1000;

export const BEAR_DATABASE_PATH =
  'Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite';

export const ENABLE_NEW_NOTE_CONVENTIONS = process.env.UI_ENABLE_NEW_NOTE_CONVENTION === 'true';
export const ENABLE_CONTENT_REPLACEMENT = process.env.UI_ENABLE_CONTENT_REPLACEMENT === 'true';

export const ERROR_MESSAGES = {
  BEAR_DATABASE_NOT_FOUND:
    'Bear database not found. Please ensure Bear Notes is installed and has been opened at least once.',
} as const;
