/** `text` cut to at most `max` characters, ending in an ellipsis when it was cut. */
export const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
