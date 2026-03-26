/**
 * tests/config.test.js
 *
 * Unit tests for lib/config.js
 */

describe('config module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules to reload config with new env vars
    jest.resetModules();
    // Clone env to avoid mutation
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    test('loads required env vars', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.SLACK_BOT_TOKEN).toBe('xoxb-test-token');
      expect(config.BRIDGE_CHANNEL).toBe('C12345');
      expect(config.OPS_CHANNEL).toBe('C67890');
    });

    test('uses default values for optional vars', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      // Clear optional vars
      delete process.env.GITHUB_ORG;
      delete process.env.POLL_INTERVAL_MS;
      delete process.env.MAX_TURNS;
      delete process.env.TASK_TIMEOUT_MS;
      delete process.env.CLAUDE_BIN;
      delete process.env.WORK_DIR;

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.GITHUB_ORG).toBe('jtpets');
      expect(config.POLL_INTERVAL).toBe(30000);
      expect(config.MAX_TURNS).toBe(50);
      expect(config.TASK_TIMEOUT).toBe(600000);
      expect(config.CLAUDE_BIN).toBe('/home/jtpets/.local/bin/claude');
      expect(config.WORK_DIR).toBe('/tmp/bridge-agent');
    });

    test('overrides defaults when env vars are set', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.GITHUB_ORG = 'customorg';
      process.env.POLL_INTERVAL_MS = '5000';
      process.env.MAX_TURNS = '100';
      process.env.TASK_TIMEOUT_MS = '300000';
      process.env.CLAUDE_BIN = '/usr/local/bin/claude';
      process.env.WORK_DIR = '/var/tmp/bridge';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.GITHUB_ORG).toBe('customorg');
      expect(config.POLL_INTERVAL).toBe(5000);
      expect(config.MAX_TURNS).toBe(100);
      expect(config.TASK_TIMEOUT).toBe(300000);
      expect(config.CLAUDE_BIN).toBe('/usr/local/bin/claude');
      expect(config.WORK_DIR).toBe('/var/tmp/bridge');
    });

    test('includes emoji constants', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.EMOJI_RUNNING).toBe('hourglass_flowing_sand');
      expect(config.EMOJI_DONE).toBe('robot_face');
      expect(config.EMOJI_FAILED).toBe('x');
    });

    test('returns frozen object', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(Object.isFrozen(config)).toBe(true);
    });
  });

  describe('getMissingVars', () => {
    test('returns empty array when all required vars present', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';

      const { loadConfig, getMissingVars } = require('../lib/config');
      const config = loadConfig();
      const missing = getMissingVars(config);

      expect(missing).toEqual([]);
    });

    test('returns SLACK_BOT_TOKEN when missing', () => {
      delete process.env.SLACK_BOT_TOKEN;
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';

      const { loadConfig, getMissingVars } = require('../lib/config');
      const config = loadConfig();
      const missing = getMissingVars(config);

      expect(missing).toContain('SLACK_BOT_TOKEN');
    });

    test('returns BRIDGE_CHANNEL_ID when missing', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      delete process.env.BRIDGE_CHANNEL_ID;
      process.env.OPS_CHANNEL_ID = 'C67890';

      const { loadConfig, getMissingVars } = require('../lib/config');
      const config = loadConfig();
      const missing = getMissingVars(config);

      expect(missing).toContain('BRIDGE_CHANNEL_ID');
    });

    test('returns OPS_CHANNEL_ID when missing', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      delete process.env.OPS_CHANNEL_ID;

      const { loadConfig, getMissingVars } = require('../lib/config');
      const config = loadConfig();
      const missing = getMissingVars(config);

      expect(missing).toContain('OPS_CHANNEL_ID');
    });

    test('returns all missing vars when multiple are missing', () => {
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.BRIDGE_CHANNEL_ID;
      delete process.env.OPS_CHANNEL_ID;

      const { loadConfig, getMissingVars } = require('../lib/config');
      const config = loadConfig();
      const missing = getMissingVars(config);

      expect(missing).toEqual(['SLACK_BOT_TOKEN', 'BRIDGE_CHANNEL_ID', 'OPS_CHANNEL_ID']);
    });
  });

  describe('validate', () => {
    test('does not exit when all required vars present', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';

      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { loadConfig, validate } = require('../lib/config');
      const config = loadConfig();
      validate(config);

      expect(mockExit).not.toHaveBeenCalled();

      mockExit.mockRestore();
      mockError.mockRestore();
    });

    test('exits with code 1 when required vars are missing', () => {
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.BRIDGE_CHANNEL_ID;
      delete process.env.OPS_CHANNEL_ID;

      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { loadConfig, validate } = require('../lib/config');
      const config = loadConfig();
      validate(config);

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockError).toHaveBeenCalled();

      mockExit.mockRestore();
      mockError.mockRestore();
    });

    test('logs missing variable names', () => {
      delete process.env.SLACK_BOT_TOKEN;
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      delete process.env.OPS_CHANNEL_ID;

      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { loadConfig, validate } = require('../lib/config');
      const config = loadConfig();
      validate(config);

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('SLACK_BOT_TOKEN')
      );
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('OPS_CHANNEL_ID')
      );

      mockExit.mockRestore();
      mockError.mockRestore();
    });
  });

  describe('ALLOWED_USER_IDS', () => {
    test('uses default value when not set', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      delete process.env.ALLOWED_USER_IDS;

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.ALLOWED_USER_IDS).toEqual(['U02QKNHHU7J']);
    });

    test('parses single user ID', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.ALLOWED_USER_IDS).toEqual(['U12345678']);
    });

    test('parses comma-separated user IDs', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678,U87654321,U11111111';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.ALLOWED_USER_IDS).toEqual(['U12345678', 'U87654321', 'U11111111']);
    });

    test('trims whitespace from user IDs', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = ' U12345678 , U87654321 ';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.ALLOWED_USER_IDS).toEqual(['U12345678', 'U87654321']);
    });

    test('filters out empty entries from comma-separated list', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678,,U87654321,';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.ALLOWED_USER_IDS).toEqual(['U12345678', 'U87654321']);
    });
  });

  describe('parseInt edge cases', () => {
    test('handles non-numeric POLL_INTERVAL_MS (defaults to NaN)', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.POLL_INTERVAL_MS = 'invalid';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      // parseInt('invalid', 10) returns NaN
      expect(config.POLL_INTERVAL).toBeNaN();
    });

    test('handles numeric string MAX_TURNS', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.MAX_TURNS = '25';

      const { loadConfig } = require('../lib/config');
      const config = loadConfig();

      expect(config.MAX_TURNS).toBe(25);
    });
  });

  describe('isUserAuthorized', () => {
    test('returns true for user in allowed list', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678,U87654321';

      const { loadConfig, isUserAuthorized } = require('../lib/config');
      const config = loadConfig();

      expect(isUserAuthorized('U12345678', config.ALLOWED_USER_IDS)).toBe(true);
      expect(isUserAuthorized('U87654321', config.ALLOWED_USER_IDS)).toBe(true);
    });

    test('returns false for user not in allowed list', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678,U87654321';

      const { loadConfig, isUserAuthorized } = require('../lib/config');
      const config = loadConfig();

      expect(isUserAuthorized('U99999999', config.ALLOWED_USER_IDS)).toBe(false);
    });

    test('returns true for default allowed user when env var not set', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      delete process.env.ALLOWED_USER_IDS;

      const { isUserAuthorized } = require('../lib/config');

      // Default allowed user is U02QKNHHU7J
      expect(isUserAuthorized('U02QKNHHU7J')).toBe(true);
    });

    test('returns false for unauthorized user with default config', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      delete process.env.ALLOWED_USER_IDS;

      const { isUserAuthorized } = require('../lib/config');

      expect(isUserAuthorized('UUNKNOWN99')).toBe(false);
    });

    test('handles empty string user ID', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678';

      const { loadConfig, isUserAuthorized } = require('../lib/config');
      const config = loadConfig();

      expect(isUserAuthorized('', config.ALLOWED_USER_IDS)).toBe(false);
    });

    test('handles undefined user ID', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.BRIDGE_CHANNEL_ID = 'C12345';
      process.env.OPS_CHANNEL_ID = 'C67890';
      process.env.ALLOWED_USER_IDS = 'U12345678';

      const { loadConfig, isUserAuthorized } = require('../lib/config');
      const config = loadConfig();

      expect(isUserAuthorized(undefined, config.ALLOWED_USER_IDS)).toBe(false);
    });
  });
});
