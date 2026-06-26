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
            "ingestApiKey",
            "ingestKey",
            "slackSigningSecret",
            "slackBotToken",
            "slackAppToken",
            "*.TELEGRAM_BOT_TOKEN",
            "*.OPENAI_API_KEY",
            "*.CODEXCHAT_INGEST_API_KEYS",
            "*.SLACK_SIGNING_SECRET",
            "*.SLACK_BOT_TOKEN",
            "*.SLACK_APP_TOKEN"
          ],
          censor: "[REDACTED]"
        }
      : undefined
  });
}
