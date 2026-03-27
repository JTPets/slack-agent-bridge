/**
 * tests/heartbeat.test.js
 *
 * Unit tests for lib/heartbeat.js
 */

const { createHeartbeat, HEARTBEAT_EMOJIS, HEARTBEAT_INTERVAL_MS } = require('../lib/heartbeat');

describe('heartbeat', () => {
  let mockSlack;
  let heartbeat;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSlack = {
      reactions: {
        add: jest.fn().mockResolvedValue({}),
        remove: jest.fn().mockResolvedValue({}),
      },
    };
    heartbeat = createHeartbeat(mockSlack, 'C123', '1234567890.123456');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constants', () => {
    it('exports heartbeat emojis array', () => {
      expect(HEARTBEAT_EMOJIS).toEqual(['hourglass_flowing_sand', 'gear']);
    });

    it('exports heartbeat interval of 30 seconds', () => {
      expect(HEARTBEAT_INTERVAL_MS).toBe(30000);
    });
  });

  describe('start()', () => {
    it('adds eyes reaction on start', async () => {
      await heartbeat.start();

      expect(mockSlack.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
    });

    it('does not crash on reaction error', async () => {
      mockSlack.reactions.add.mockRejectedValue(new Error('API error'));

      // Should not throw
      await expect(heartbeat.start()).resolves.not.toThrow();
    });
  });

  describe('heartbeat cycling', () => {
    it('cycles through emojis every 30 seconds', async () => {
      await heartbeat.start();

      // Initial: eyes
      expect(mockSlack.reactions.add).toHaveBeenCalledTimes(1);

      // After 30s: hourglass_flowing_sand
      jest.advanceTimersByTime(30000);
      // Flush microtasks and pending promises
      await jest.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      expect(mockSlack.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'hourglass_flowing_sand',
      });

      // After another 30s: gear (and remove hourglass)
      jest.advanceTimersByTime(30000);
      await jest.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      expect(mockSlack.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'hourglass_flowing_sand',
      });
      expect(mockSlack.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'gear',
      });
    });
  });

  describe('stop()', () => {
    it('removes eyes and adds white_check_mark on success', async () => {
      await heartbeat.start();
      mockSlack.reactions.add.mockClear();
      mockSlack.reactions.remove.mockClear();

      await heartbeat.stop(true);

      expect(mockSlack.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
      expect(mockSlack.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'white_check_mark',
      });
    });

    it('removes eyes and adds x on failure', async () => {
      await heartbeat.start();
      mockSlack.reactions.add.mockClear();
      mockSlack.reactions.remove.mockClear();

      await heartbeat.stop(false);

      expect(mockSlack.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
      expect(mockSlack.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'x',
      });
    });

    it('removes eyes without adding final emoji when success is null (rate limit)', async () => {
      await heartbeat.start();
      mockSlack.reactions.add.mockClear();
      mockSlack.reactions.remove.mockClear();

      await heartbeat.stop(null);

      expect(mockSlack.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'eyes',
      });
      // Should not add any final emoji
      expect(mockSlack.reactions.add).not.toHaveBeenCalled();
    });

    it('clears interval timer on stop', async () => {
      await heartbeat.start();

      await heartbeat.stop(true);

      // Advance time - no more reactions should be added
      mockSlack.reactions.add.mockClear();
      jest.advanceTimersByTime(60000);
      await Promise.resolve();

      // Only the white_check_mark was added, not heartbeat emojis
      expect(mockSlack.reactions.add).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'hourglass_flowing_sand' })
      );
    });

    it('removes last heartbeat emoji on stop', async () => {
      await heartbeat.start();

      // Advance to trigger heartbeat
      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      mockSlack.reactions.remove.mockClear();

      await heartbeat.stop(true);

      // Should remove hourglass_flowing_sand (the last heartbeat emoji)
      expect(mockSlack.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'hourglass_flowing_sand',
      });
    });

    it('does not crash on reaction error during stop', async () => {
      await heartbeat.start();
      mockSlack.reactions.remove.mockRejectedValue(new Error('API error'));
      mockSlack.reactions.add.mockRejectedValue(new Error('API error'));

      // Should not throw
      await expect(heartbeat.stop(true)).resolves.not.toThrow();
    });
  });

  describe('error handling', () => {
    it('handles already_reacted error silently', async () => {
      const error = new Error('already_reacted');
      error.data = { error: 'already_reacted' };
      mockSlack.reactions.add.mockRejectedValue(error);

      // Should not throw or log error
      await expect(heartbeat.start()).resolves.not.toThrow();
    });

    it('heartbeat tick continues on error', async () => {
      await heartbeat.start();

      // Make first tick fail
      mockSlack.reactions.add.mockRejectedValueOnce(new Error('API error'));

      jest.advanceTimersByTime(30000);
      await jest.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      // Second tick should still work
      mockSlack.reactions.add.mockResolvedValue({});
      jest.advanceTimersByTime(30000);
      await jest.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      expect(mockSlack.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '1234567890.123456',
        name: 'gear',
      });
    });
  });
});
