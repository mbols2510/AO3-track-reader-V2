import type { ReaderSettings, WorkChapter } from '@ao3track/core';

/** Messages from content scripts / options page to the background worker. */
export type Msg =
  | { type: 'GET_DETAILS'; works: number[] }
  | { type: 'SET'; data: Record<number, WorkChapter> }
  | { type: 'FILTER'; workid: number; authors: string[]; tags: string[]; series: number[] }
  | { type: 'URLS_IN_LIST'; urls: string[] }
  | { type: 'RL_TOGGLE'; url: string }
  | { type: 'SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: ReaderSettings }
  | { type: 'STATUS' }
  | { type: 'DO_SYNC' }
  | { type: 'LOGIN'; server: string; username: string; password: string; create?: boolean; email?: string }
  | { type: 'LOGOUT' }
  | { type: 'REMOVE_FILTER'; filter: string };

export const send = <T = unknown>(m: Msg): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;
