import type { IncomingMessage } from "../types.ts";
import { mergeAlbum } from "./message.ts";

/**
 * Collects the messages of an album (photos or files sent together), which arrive one by one,
 * and hands them over as one message once no more have come for `waitMs`.
 */
export class AlbumBuffer {
  private readonly albums = new Map<
    string,
    { messages: IncomingMessage[]; timer?: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly waitMs: number) {}

  add(key: string, message: IncomingMessage, onComplete: (album: IncomingMessage) => void): void {
    const album = this.albums.get(key) ?? { messages: [] };
    this.albums.set(key, album);
    album.messages.push(message);
    clearTimeout(album.timer);
    album.timer = setTimeout(() => {
      this.albums.delete(key);
      const merged = mergeAlbum(album.messages);
      if (merged) onComplete(merged);
    }, this.waitMs);
  }

  /** Drop the albums still waiting. */
  stop(): void {
    for (const album of this.albums.values()) clearTimeout(album.timer);
  }
}
