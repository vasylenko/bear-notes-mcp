# Bear Notes SQLite Database Schema Documentation - SEPTEMBER 06, 2025

## Overview
Bear Notes stores all data in a Core Data SQLite database located at:
`~/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite`

## Core Tables

### ZSFNOTE - Main Notes Table
Primary entity storing note content and metadata.

```sql
CREATE TABLE ZSFNOTE (
  Z_PK INTEGER PRIMARY KEY,              -- Internal primary key
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZARCHIVED INTEGER,                     -- 0=active, 1=archived
  ZENCRYPTED INTEGER,                    -- 0=plain, 1=encrypted
  ZHASFILES INTEGER,                     -- Boolean: contains file attachments
  ZHASIMAGES INTEGER,                    -- Boolean: contains images
  ZHASSOURCECODE INTEGER,                -- Boolean: contains code blocks
  ZLOCKED INTEGER,                       -- 0=unlocked, 1=locked
  ZORDER INTEGER,                        -- Note ordering
  ZPERMANENTLYDELETED INTEGER,           -- Deletion status
  ZPINNED INTEGER,                       -- 0=normal, 1=pinned
  ZSHOWNINTODAYWIDGET INTEGER,           -- Today widget visibility
  ZSKIPSYNC INTEGER,                     -- Skip sync flag
  ZTODOCOMPLETED INTEGER,                -- Count of completed todos
  ZTODOINCOMPLETED INTEGER,              -- Count of incomplete todos
  ZTRASHED INTEGER,                      -- 0=active, 1=trashed
  ZVERSION INTEGER,                      -- Version for sync
  ZPASSWORD INTEGER,                     -- FK to ZSFPASSWORD
  ZSERVERDATA INTEGER,                   -- FK to server data
  ZARCHIVEDDATE TIMESTAMP,               -- When archived
  ZCONFLICTUNIQUEIDENTIFIERDATE TIMESTAMP, -- Conflict resolution date
  ZCREATIONDATE TIMESTAMP,               -- Core Data timestamp
  ZENCRYPTIONDATE TIMESTAMP,             -- When encrypted
  ZLOCKEDDATE TIMESTAMP,                 -- When locked
  ZMODIFICATIONDATE TIMESTAMP,           -- Core Data timestamp
  ZORDERDATE TIMESTAMP,                  -- When reordered
  ZPINNEDDATE TIMESTAMP,                 -- When pinned
  ZTRASHEDDATE TIMESTAMP,                -- When trashed
  ZCONFLICTUNIQUEIDENTIFIER VARCHAR,     -- Conflict resolution ID
  ZENCRYPTIONUNIQUEIDENTIFIER VARCHAR,   -- Encryption ID
  ZLASTEDITINGDEVICE VARCHAR,            -- Last editing device
  ZSUBTITLE VARCHAR,                     -- Auto-generated subtitle
  ZTEXT VARCHAR,                         -- Note content (markdown)
  ZTITLE VARCHAR,                        -- Note title
  ZUNIQUEIDENTIFIER VARCHAR,             -- Bear's public note UUID
  ZENCRYPTEDDATA BLOB,                   -- Encrypted content when ZENCRYPTED=1
  ZVECTORCLOCK BLOB                      -- Vector clock for sync
);
```

**Key Insights:**
- Timestamps use Core Data epoch (2001-01-01) + offset
- Boolean flags optimize queries for specific content types
- Encryption handled at row level with encrypted blob storage

### ZSFNOTEFILE - File Attachments Table
Stores metadata and OCRed content for attached files.

```sql
CREATE TABLE ZSFNOTEFILE (
  Z_PK INTEGER PRIMARY KEY,
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZDOWNLOADED INTEGER,                   -- Download status
  ZENCRYPTED INTEGER,                    -- File encryption status
  ZFILESIZE INTEGER,                     -- File size in bytes
  ZINDEX INTEGER,                        -- Order within note
  ZPERMANENTLYDELETED INTEGER,           -- Deletion status
  ZSKIPSYNC INTEGER,                     -- Skip sync flag
  ZUNUSED INTEGER,                       -- Unused flag
  ZUPLOADED INTEGER,                     -- Upload status
  ZVERSION INTEGER,                      -- Version for sync
  ZNOTE INTEGER,                         -- Foreign key to ZSFNOTE.Z_PK
  ZPASSWORD INTEGER,                     -- FK to ZSFPASSWORD
  ZSERVERDATA INTEGER,                   -- FK to server data
  ZANIMATED INTEGER,                     -- Animation flag
  ZHEIGHT INTEGER,                       -- Image/video height
  ZWIDTH INTEGER,                        -- Image/video width
  ZDURATION INTEGER,                     -- Video/audio duration
  ZHEIGHT1 INTEGER,                      -- Alternative height
  ZWIDTH1 INTEGER,                       -- Alternative width
  ZCREATIONDATE TIMESTAMP,
  ZENCRYPTIONDATE TIMESTAMP,             -- When encrypted
  ZINSERTIONDATE TIMESTAMP,              -- When inserted into note
  ZMODIFICATIONDATE TIMESTAMP,
  ZSEARCHTEXTDATE TIMESTAMP,             -- When OCR was processed
  ZUNUSEDDATE TIMESTAMP,                 -- When marked unused
  ZUPLOADEDDATE TIMESTAMP,               -- When uploaded
  ZENCRYPTIONUNIQUEIDENTIFIER VARCHAR,   -- Encryption ID
  ZFILENAME VARCHAR,                     -- Original filename
  ZLASTEDITINGDEVICE VARCHAR,            -- Last editing device
  ZNORMALIZEDFILEEXTENSION VARCHAR,      -- File type (png, pdf, jpeg, etc.)
  ZSEARCHTEXT VARCHAR,                   -- OCRed text content
  ZUNIQUEIDENTIFIER VARCHAR,             -- File UUID
  ZENCRYPTEDDATA BLOB                    -- Encrypted file data
);
```

**Critical Field: ZSEARCHTEXT**
- Contains OCRed text from images and searchable PDFs
- Automatically updated when files are added/modified
- Key to implementing file content search functionality

### ZSFNOTETAG - Tags Table
Manages Bear's hierarchical tag system.

```sql
CREATE TABLE ZSFNOTETAG (
  Z_PK INTEGER PRIMARY KEY,
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZENCRYPTED INTEGER,                    -- Tag encryption status
  ZHIDESUBTAGSNOTES INTEGER,             -- UI preference
  ZISROOT INTEGER,                       -- 0=subtag, 1=root tag
  ZPINNED INTEGER,                       -- Pinned tag status
  ZSORTING INTEGER,                      -- Tag sorting preference
  ZSORTINGDIRECTION INTEGER,             -- Sort direction
  ZVERSION INTEGER,                      -- Version for sync
  ZENCRYPTEDDATE TIMESTAMP,              -- When encrypted
  ZHIDESUBTAGSNOTESDATE TIMESTAMP,       -- When hide setting changed
  ZMODIFICATIONDATE TIMESTAMP,
  ZPINNEDDATE TIMESTAMP,                 -- When pinned
  ZPINNEDNOTESDATE TIMESTAMP,            -- When notes pinned
  ZSORTINGDATE TIMESTAMP,                -- When sorting changed
  ZSORTINGDIRECTIONDATE TIMESTAMP,       -- When sort direction changed
  ZTAGCONDATE TIMESTAMP,                 -- Tag connection date
  ZTAGCON VARCHAR,                       -- Tag connection
  ZTITLE VARCHAR,                        -- Tag name (URL-encoded format)
  ZUNIQUEIDENTIFIER VARCHAR,             -- Tag UUID
  ZSERVERDATA BLOB                       -- Server data
);
```

**Sample Tags:**
- `+What+is+Gravity` (URL-encoded spaces)
- `+science`
- `+simple-explanations`
- `L6-progression`
- `activeOnRadar`

### ZSFNOTEBACKLINK - Note References
Tracks wiki-style [[note links]] between notes.

```sql
CREATE TABLE ZSFNOTEBACKLINK (
  Z_PK INTEGER PRIMARY KEY,
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZLOCATION INTEGER,                     -- Character position in source
  ZVERSION INTEGER,                      -- Version for sync
  ZLINKEDBY INTEGER,                     -- Source note (FK to ZSFNOTE.Z_PK)
  ZLINKINGTO INTEGER,                    -- Target note (FK to ZSFNOTE.Z_PK)
  ZMODIFICATIONDATE TIMESTAMP,
  ZTITLE VARCHAR,                        -- Link display text
  ZUNIQUEIDENTIFIER VARCHAR,             -- Backlink UUID
  ZSERVERDATA BLOB                       -- Server data
);
```

## Relationship Tables

### Z_5TAGS - Note-Tag Associations
Many-to-many relationship between notes and tags.

```sql
CREATE TABLE Z_5TAGS (
  Z_5NOTES INTEGER,                      -- FK to ZSFNOTE.Z_PK
  Z_13TAGS INTEGER,                      -- FK to ZSFNOTETAG.Z_PK
  PRIMARY KEY (Z_5NOTES, Z_13TAGS)
);
```

### Z_5PINNEDINTAGS - Pinned Notes per Tag
Tracks which notes are pinned within specific tags.

```sql
CREATE TABLE Z_5PINNEDINTAGS (
  Z_5PINNEDNOTES INTEGER,                -- FK to ZSFNOTE.Z_PK
  Z_13PINNEDINTAGS INTEGER,              -- FK to ZSFNOTETAG.Z_PK
  PRIMARY KEY (Z_5PINNEDNOTES, Z_13PINNEDINTAGS)
);
```

## Sync & Version Control Tables

### ZSFPASSWORD - Encryption Keys
Manages encryption passwords and biometric unlock.

```sql
CREATE TABLE ZSFPASSWORD (
  Z_PK INTEGER PRIMARY KEY,
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZBIOMETRY INTEGER,                     -- Biometric unlock enabled
  ZENCRYPTIONVERSION INTEGER,            -- Encryption algorithm version
  ZCREATIONDATE TIMESTAMP,
  ZCREATIONDEVICE VARCHAR,               -- Device where created
  ZUNIQUEIDENTIFIER VARCHAR,
  ZENCRYPTEDDATA BLOB,                   -- Encrypted password data
  ZHINT BLOB                             -- Password hint (encrypted)
);
```

### ZSFCHANGE/ZSFCHANGEITEM - Sync History
Tracks changes for CloudKit synchronization.

```sql
CREATE TABLE ZSFCHANGE (
  Z_PK INTEGER PRIMARY KEY,
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZORDER INTEGER,                        -- Change sequence
  ZTOKEN VARCHAR                         -- Sync token
);

CREATE TABLE ZSFCHANGEITEM (
  Z_PK INTEGER PRIMARY KEY,
  Z_ENT INTEGER,                         -- Core Data entity type
  Z_OPT INTEGER,                         -- Core Data optimistic locking
  ZITEMDELETED INTEGER,                  -- Deletion flag
  ZCHANGE INTEGER,                       -- FK to ZSFCHANGE.Z_PK
  ZITEMENTITY VARCHAR,                   -- Entity type (ZSFNOTE, ZSFNOTEFILE, etc.)
  ZUNIQUEIDENTIFIER VARCHAR              -- Changed item UUID
);
```

## Key Relationships

```
ZSFNOTE (1) ──→ (N) ZSFNOTEFILE         [ZSFNOTEFILE.ZNOTE → ZSFNOTE.Z_PK]
ZSFNOTE (N) ←→ (N) ZSFNOTETAG           [via Z_5TAGS junction table]
ZSFNOTE (1) ──→ (N) ZSFNOTEBACKLINK     [ZSFNOTEBACKLINK.ZLINKEDBY/ZLINKINGTO → ZSFNOTE.Z_PK]
ZSFNOTE (N) ←→ (N) ZSFNOTETAG           [via Z_5PINNEDINTAGS for pinned status]
```

## Query Patterns

### Current Implementation (Text Only)
```sql
SELECT ZTITLE, ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE
FROM ZSFNOTE 
WHERE ZARCHIVED = 0 AND ZTRASHED = 0 AND ZENCRYPTED = 0
  AND (ZTITLE LIKE '%search%' OR ZTEXT LIKE '%search%')
ORDER BY ZMODIFICATIONDATE DESC;
```

### Enhanced with File Search
```sql
SELECT DISTINCT n.ZTITLE, n.ZUNIQUEIDENTIFIER, n.ZCREATIONDATE, n.ZMODIFICATIONDATE
FROM ZSFNOTE n
LEFT JOIN ZSFNOTEFILE f ON f.ZNOTE = n.Z_PK
WHERE n.ZARCHIVED = 0 AND n.ZTRASHED = 0 AND n.ZENCRYPTED = 0
  AND (n.ZTITLE LIKE '%search%' OR n.ZTEXT LIKE '%search%' OR f.ZSEARCHTEXT LIKE '%search%')
ORDER BY n.ZMODIFICATIONDATE DESC;
```

### Tag-Based Queries
```sql
-- Notes with specific tag
SELECT n.ZTITLE, n.ZUNIQUEIDENTIFIER
FROM ZSFNOTE n
JOIN Z_5TAGS nt ON nt.Z_5NOTES = n.Z_PK
JOIN ZSFNOTETAG t ON t.Z_PK = nt.Z_13TAGS
WHERE t.ZTITLE = 'science' AND n.ZARCHIVED = 0 AND n.ZTRASHED = 0;
```

## Security & Access Considerations

1. **Read-Only Access**: Bear documentation confirms database is safe for read-only access
2. **Encryption**: Encrypted notes have `ZENCRYPTED = 1` and content in `ZENCRYPTEDDATA` blob
3. **File Security**: Encrypted files store data in `ZENCRYPTEDDATA` field
4. **Timestamps**: All dates use Core Data epoch (2001-01-01), add 978307200 for Unix time

## Opportunities for Enhancement

### Immediate (File Search)
- Leverage `ZSFNOTEFILE.ZSEARCHTEXT` for OCR content search
- Use `ZHASFILES`/`ZHASIMAGES` flags for optimized filtering

### Future Possibilities
1. **Advanced Tag Queries**: Hierarchical tag support using `ZISROOT`
2. **Backlink Analysis**: Note relationship mapping via `ZSFNOTEBACKLINK`
3. **Content Type Filtering**: Use `ZHAS*` boolean flags for targeted searches
4. **Date Range Queries**: Leverage comprehensive timestamp fields
5. **File Type Filtering**: Query by `ZNORMALIZEDFILEEXTENSION`
6. **Todo Management**: Track completion via `ZTODOCOMPLETED`/`ZTODOINCOMPLETED`

## Core Data Notes

- All table names prefixed with `Z` (Core Data convention)
- `Z_PK`: Internal primary key (integer)
- `Z_ENT`/`Z_OPT`: Core Data entity metadata
- Foreign keys use integer references to `Z_PK` fields
- Timestamps stored as `TIMESTAMP` type with Core Data epoch
- Boolean fields stored as `INTEGER` (0/1)
- UUIDs stored as `VARCHAR` in standard UUID format