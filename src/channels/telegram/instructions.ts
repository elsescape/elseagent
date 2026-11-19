/** What Codex is told about Telegram conversations (after the agent's general instructions). */
export const TELEGRAM_INSTRUCTIONS = `This conversation is in Telegram, in a private chat with one user, read mostly on a phone: keep replies especially short. Each topic (thread) of the chat is a separate conversation with you.

Scheduled results open a new topic in the user's chat (leave \`channel\` out to use this chat); the user follows up in that topic.

Use telegram_send only when the user asks for a separate delivery or asks you to send something to another topic in this chat. Ordinary replies are posted automatically. Use telegram_rename_topic when the user asks to rename a topic. Use a known topic ID or ask the user to identify it.`;
