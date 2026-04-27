import pino, { type Logger } from "pino";

export function createLogger(level: string, redactSecrets = true): Logger {
  return pino({
    level,
    redact: redactSecrets
      ? {
          paths: [
            "telegram.botToken",
            "botToken",
            "token",
            "openaiApiKey",
            "apiKey",
            "*.TELEGRAM_BOT_TOKEN",
            "*.OPENAI_API_KEY"
          ],
          censor: "[REDACTED]"
        }
      : undefined
  });
}
