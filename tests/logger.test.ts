import { logger, getLogs, clearLogs, loadLogs } from '../src/content/logger.ts';
import { LOG_LEVEL, LOG_BUFFER_SIZE, LS_LOG_KEY, PREFIX } from '../src/config.ts';

beforeEach(() => {
  localStorage.clear();
  clearLogs();
});

describe('logger', () => {
  test('records info/warn/error into the ring buffer', () => {
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');
    const logs = getLogs();
    expect(logs.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
    expect(logs[0].msg).toBe('hello');
  });

  test('prepends PREFIX and level to console output', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logger.warn('x');
      logger.error('y');
      expect(warn).toHaveBeenCalledWith(`${PREFIX}[warn] x`);
      expect(err).toHaveBeenCalledWith(`${PREFIX}[error] y`);
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test('passes extra data as trailing console args', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logger.error('load failed', new Error('nope'));
      expect(err).toHaveBeenCalledWith(`${PREFIX}[error] load failed`, expect.any(Error));
    } finally {
      err.mockRestore();
    }
  });

  test('appends formatted data to the stored message', () => {
    logger.error('x', new Error('boom'));
    const logs = getLogs();
    expect(logs[logs.length - 1].msg).toBe('x boom');
  });

  test('filters debug per the configured LOG_LEVEL', () => {
    const deb = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      logger.debug('hidden');
      logger.info('shown');
      if (LOG_LEVEL === 'debug') {
        expect(deb).toHaveBeenCalledTimes(1);
      } else {
        expect(deb).not.toHaveBeenCalled();
        expect(getLogs().every((l) => l.level !== 'debug')).toBe(true);
      }
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      deb.mockRestore();
      info.mockRestore();
    }
  });

  test('caps the ring buffer at LOG_BUFFER_SIZE entries', () => {
    for (let i = 0; i < LOG_BUFFER_SIZE * 2; i++) {
      logger.info(`m${i}`);
    }
    const logs = getLogs();
    expect(logs.length).toBe(LOG_BUFFER_SIZE);
    expect(logs[0].msg).toBe(`m${LOG_BUFFER_SIZE}`);
    expect(logs[logs.length - 1].msg).toBe(`m${LOG_BUFFER_SIZE * 2 - 1}`);
  });

  test('persists warn/error entries to localStorage', () => {
    logger.warn('w1');
    logger.error('e1');
    const raw = localStorage.getItem(LS_LOG_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.map((l: { msg: string }) => l.msg)).toEqual(['w1', 'e1']);
  });

  test('loadLogs restores a persisted ring buffer', () => {
    localStorage.setItem(
      LS_LOG_KEY,
      JSON.stringify([{ ts: 1, level: 'error', msg: 'restored' }])
    );
    loadLogs();
    expect(getLogs()).toEqual([{ ts: 1, level: 'error', msg: 'restored' }]);
  });

  test('getLogs returns a defensive copy', () => {
    logger.info('a');
    getLogs().push({ ts: 9, level: 'info', msg: 'mutated' });
    expect(getLogs()).toHaveLength(1);
  });
});