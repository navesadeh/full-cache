/* global globalThis */

export const logger = {
  ...createLogger('log'),
  ...createLogger('info'),
  ...createLogger('warn'),
  ...createLogger('error'),
  ...createLogger('debug'),
};

const typesStyle = {
  'utils': 'color: #fc4c9b',
  'get-response': 'color: #fc814c',
  'polling': 'color: #c7fc4c',
  'socket': 'color: #78fc4c',
  'install': 'color: #4cfc61',
  'activate': 'color: #4ccdfc',
  'warm-up': 'color: #4c58fc',
  'dedup': 'color:rgb(76, 252, 167)',
  'api-cache-manager': 'color: #874cfc',
  'cache-config-sync-client': 'color: #dc4cfc',
  'cache-config-store': 'color: #fc4c84',
};

const levelStyle = {
  log: 'color: #c5c5c5',
  info: 'color: #4cfcf5',
  warn: 'color: #fcf54c',
  error: 'color: #fc4c4c',
  debug: 'color: #c5c5c5',
};

/**
 * @typedef {keyof typeof levelStyle} LogLevel
 */

/**
 * @typedef {keyof typeof typesStyle} LoggerType
 */

/**
 * Creates a logger with the specified log level.
 * @param {LogLevel} level the log level to use
 * @returns {Record<LogLevel, (type: LoggerType, ...args: unknown[]) => void>}
 */
function createLogger(level) {
  return {
    [level]: (type, ...args) => {
      globalThis.otelLogger?.log(level, args.join(' '));

      printUserFriendlyLog(level, type, ...args);
    },
  };
}

/**
 * Prints a user-friendly log message to the console.
 * @param {LogLevel} level the log level
 * @param {LoggerType} type the log type
 * @param {message} message the log message
 * @param {unknown} data additional data to log
 */
function printUserFriendlyLog(level, type, message, data) {
  const stackWithoutErrorPrefix = new Error().stack
    .split('\n')
    .slice(1)
    .map(line => line.replace(/^\s+at /, ''));
  const lastPlaceOnStackOutsideThisFunction = stackWithoutErrorPrefix[2];
  const lastPlaceOnStackPath = lastPlaceOnStackOutsideThisFunction.replace(/.*\((.*)\)/, '$1');

  const time = new Date()
    .toLocaleTimeString('en-US', { hour12: false })
    .replace(/(.*:\d{2}:\d{2}).*/, '$1');

  const timeWithStyle = { text: `${time}`, style: 'color: #747474; font-weight: bold' };
  const logPrefixWithStyle = { text: 'service-worker', style: 'color: #686868' };
  const levelWithStyle = { text: level.toUpperCase().padEnd(6, ' '), style: levelStyle[level] };
  const logTypeWithStyle = { text: `[${type}]`, style: typesStyle[type] };
  const logMessageWithStyle = { text: message, style: 'color: white' };
  const lastPlaceOnStackPathWithStyle = {
    text: lastPlaceOnStackPath,
    style: 'font-size: 8px; font-style: italic; color: #c5c5c5',
  };

  console[level](
    `%c${timeWithStyle.text}%c | ${logPrefixWithStyle.text} | %c${levelWithStyle.text} %c${logTypeWithStyle.text} %c${logMessageWithStyle.text}\n%c${lastPlaceOnStackPathWithStyle.text}${data ? '\n' : ''}`,
    timeWithStyle.style,
    logPrefixWithStyle.style,
    levelWithStyle.style,
    logTypeWithStyle.style,
    logMessageWithStyle.style,
    lastPlaceOnStackPathWithStyle.style,
    data || ''
  );
}
