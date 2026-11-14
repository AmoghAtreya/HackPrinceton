export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text
  for (const secret of secrets) {
    if (secret.length >= 8) safe = safe.split(secret).join('[redacted]')
  }
  return safe
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, '[redacted API key]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted API key]')
    .replace(/\bAQ\.[0-9A-Za-z_.-]{20,}/g, '[redacted API key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
}
