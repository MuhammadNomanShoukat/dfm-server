type LogFields = Record<string, unknown>;

function write(level: string, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') {
    process.stderr.write(`${serialized}\n`);
    return;
  }
  process.stdout.write(`${serialized}\n`);
}

export const logger = {
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};
