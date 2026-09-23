/**
 * Wire types shared by every component. These mirror the original Ao3Track
 * protocol exactly (field names are lowercase on the wire), so data synced by
 * the 2017-era apps keeps working unchanged.
 */

/** Milliseconds since the Unix epoch. */
export type Timestamp = number;

/** Where a reader is inside a work. See location.ts for the encoding. */
export interface WorkChapter {
  /** 1-based chapter ordinal. */
  number: number;
  /** AO3 chapter id (0 for single-chapter works). */
  chapterid: number;
  /** Encoded position inside the chapter; `null` means "finished the chapter". */
  location: number | null;
  /** Sequence number. Higher always wins (used to force a reset, e.g. "mark unread"). */
  seq: number | null;
}

export interface WorkChapterTS extends WorkChapter {
  timestamp: Timestamp;
}

export interface WorkChapterEx extends WorkChapter {
  workid: number;
}

/** Server shape: `seq` is always a number on the wire. */
export interface StoredWorkChapter {
  number: number;
  chapterid: number;
  location: number | null;
  timestamp: Timestamp;
  seq: number;
}

export type WorkMap = Record<string, StoredWorkChapter>;

/** POST api/ReadingList body and response. `-1` in a response means "delete". */
export interface ReadingListSync {
  last_sync: Timestamp;
  paths: Record<string, Timestamp>;
}

/** POST api/ListFilters body and response. `-1` in a response means "delete". */
export interface ListFiltersSync {
  last_sync: Timestamp;
  filters: Record<string, Timestamp>;
}

export type FormErrors = Record<string, string>;

export const UnitConv = { None: 0, MetricToUS: 1, USToMetric: 2 } as const;
export type UnitConvSetting = (typeof UnitConv)[keyof typeof UnitConv];

export interface ReaderSettings {
  unitConv: { temp: UnitConvSetting; dist: UnitConvSetting; volume: UnitConvSetting; weight: UnitConvSetting };
  tags: { showCatTags: boolean; showWIPTags: boolean; showRatingTags: boolean };
  listFiltering: { hideFilteredWorks: boolean; onlyGeneralTeen: boolean };
  override_site_theme: boolean;
  theme: 'light' | 'dark';
}

export const defaultReaderSettings = (): ReaderSettings => ({
  unitConv: { temp: UnitConv.None, dist: UnitConv.None, volume: UnitConv.None, weight: UnitConv.None },
  tags: { showCatTags: true, showWIPTags: true, showRatingTags: true },
  listFiltering: { hideFilteredWorks: false, onlyGeneralTeen: false },
  override_site_theme: false,
  theme: 'light',
});

/** Metadata the tracker extracts for a work (from its search blurb). */
export interface WorkMeta {
  workid: number;
  title: string;
  authors: string[];
  fandoms: string[];
  rating: string | null;
  warnings: string[];
  categories: string[];
  relationships: string[];
  characters: string[];
  freeforms: string[];
  summary: string;
  language: string | null;
  words: number | null;
  chaptersPublished: number | null;
  chaptersTotal: number | null;
  complete: boolean;
  updated: string | null;
  series: { id: number; title: string; part: number | null }[];
  kudos: number | null;
  hits: number | null;
  fetchedAt: Timestamp;
}

export interface SeriesMeta {
  seriesid: number;
  title: string;
  authors: string[];
  workIds: number[];
  complete: boolean | null;
  updated: string | null;
  fetchedAt: Timestamp;
}
