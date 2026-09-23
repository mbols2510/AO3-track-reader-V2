import { defaultReaderSettings, emptySyncState, type ReaderSettings, type SyncState, type WorkMeta, type SeriesMeta } from '@ao3track/core';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  fontSize: number;              // percent, applied to story text
  trackerUrl: string;            // optional tracker service, e.g. http://localhost:8081
  trackerKey: string;            // tracker API_KEY, needed when the tracker is exposed publicly
  refreshHours: number;          // background reading-list refresh (direct mode); 0 = off
  homeUrl: string;
  lastUrl: string | null;
  favourites: string[];
  readingListSort: 'unread' | 'updated' | 'added' | 'title';
  readingListFilter: 'all' | 'unread' | 'complete' | 'favourites';
  bounds: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  paneOpen: boolean;
}

export interface AppState {
  version: 2;
  sync: SyncState;
  settings: ReaderSettings;
  prefs: Prefs;
}

export const defaultState = (): AppState => ({
  version: 2,
  sync: emptySyncState(),
  settings: defaultReaderSettings(),
  prefs: {
    theme: 'system', fontSize: 100, trackerUrl: '', trackerKey: '', refreshHours: 6,
    homeUrl: 'https://archiveofourown.org/', lastUrl: null, favourites: [],
    readingListSort: 'unread', readingListFilter: 'all',
    bounds: { width: 1280, height: 860 }, paneOpen: true,
  },
});

export interface MetaCacheFile {
  works: Record<string, WorkMeta>;
  missing: Record<string, number>;
  series: Record<string, SeriesMeta>;
}
export const defaultMeta = (): MetaCacheFile => ({ works: {}, missing: {}, series: {} });
