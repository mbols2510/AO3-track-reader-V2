import type { ReaderSettings, WorkChapter, WorkChapterEx } from '@ao3track/core';

export interface WorkDetails {
  savedLoc?: WorkChapter;
  inReadingList?: boolean;
}

export interface PageTitle {
  title: string;
  chapter?: string;
  chaptername?: string;
  authors?: string[];
  fandoms?: string[];
  primarytag?: string | null;
}

/**
 * What the page script needs from its host (browser extension or desktop
 * reader). Mirrors the original Ao3Track.Helper interface.
 */
export interface Bridge {
  settings: ReaderSettings;
  getWorkDetails(works: number[]): Promise<Record<number, WorkDetails>>;
  setWorkChapters(workchapters: Record<number, WorkChapter>): void;
  shouldFilterWork(workid: number, authors: string[], tags: string[], series: number[]): Promise<string | null>;
  areUrlsInReadingList(urls: string[]): Promise<Record<string, boolean>>;
  setNextPage(url: string | null): void;
  setPrevPage(url: string | null): void;
  /** Called with the last saved location once known; host shows a "jump" affordance. */
  enableLastLocationJump(workid: number, loc: WorkChapter): void;
  setCurrentLocation(loc: WorkChapterEx): void;
  setPageTitle?(t: PageTitle): void;
  /** Host UI hooks: returns an unsubscribe function. */
  onJumpRequest?(fn: () => void): void;
}
