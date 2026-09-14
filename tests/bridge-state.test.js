/**
 * tests/bridge-state.test.js
 *
 * Unit tests for lib/bridge-state.js — the file-backed state persistence
 * extracted from bridge-agent.js (seam B, docs/WIRING-AND-SEAMS.md).
 *
 * Covers every exported function per the no-new-function rule, using temp-dir
 * file overrides so nothing touches the real repo-root state files. The two
 * on-disk contracts pinned here:
 *   - per-channel lastChecked cursors (loadState/saveState/get/setLastChecked),
 *     including the legacy single-channel -> multi-channel migration
 *   - processed-task dedup timestamps (isTaskProcessed/markTaskProcessed/cleanup)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const bridgeState = require('../lib/bridge-state');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-test-'));
}

describe('module export surface', () => {
  test('exports the seam-B accessors as functions', () => {
    for (const name of [
      'init', 'loadState', 'saveState', 'getLastChecked', 'setLastChecked',
      'loadProcessedTasks', 'saveProcessedTasks', 'isTaskProcessed',
      'markTaskProcessed', 'cleanupProcessedTasks',
    ]) {
      expect(typeof bridgeState[name]).toBe('function');
    }
  });
});

describe('lastChecked poll cursors', () => {
  let dir;
  let stateFile;
  let processedTasksFile;

  beforeEach(() => {
    dir = tempDir();
    stateFile = path.join(dir, 'state.json');
    processedTasksFile = path.join(dir, 'processed-tasks.json');
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('getLastChecked returns "0" for an unseen channel', () => {
    expect(bridgeState.getLastChecked('C_NEW')).toBe('0');
  });

  test('setLastChecked persists per-channel and survives a reload', () => {
    bridgeState.setLastChecked('C_A', '111.1');
    bridgeState.setLastChecked('C_B', '222.2');
    expect(bridgeState.getLastChecked('C_A')).toBe('111.1');

    // File is written in the new { channels: {...} } shape.
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(onDisk).toEqual({ channels: { C_A: '111.1', C_B: '222.2' } });

    // A fresh init() reads it back.
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
    expect(bridgeState.getLastChecked('C_B')).toBe('222.2');
  });

  test('migrates legacy single-channel format onto the bridge channel', () => {
    fs.writeFileSync(stateFile, JSON.stringify({ lastChecked: '999.9' }), 'utf8');
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
    expect(bridgeState.getLastChecked('C_BRIDGE')).toBe('999.9');
  });

  test('missing or corrupt state file loads as empty', () => {
    fs.writeFileSync(stateFile, 'not json', 'utf8');
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
    expect(bridgeState.getLastChecked('C_BRIDGE')).toBe('0');
  });
});

describe('processed-task dedup', () => {
  let dir;
  let stateFile;
  let processedTasksFile;

  beforeEach(() => {
    dir = tempDir();
    stateFile = path.join(dir, 'state.json');
    processedTasksFile = path.join(dir, 'nested', 'processed-tasks.json');
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('markTaskProcessed makes isTaskProcessed true and creates the file (with parent dir)', () => {
    expect(bridgeState.isTaskProcessed('123.4')).toBe(false);
    bridgeState.markTaskProcessed('123.4');
    expect(bridgeState.isTaskProcessed('123.4')).toBe(true);
    expect(fs.existsSync(processedTasksFile)).toBe(true);
  });

  test('processed timestamps survive a reload', () => {
    bridgeState.markTaskProcessed('555.5');
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
    expect(bridgeState.isTaskProcessed('555.5')).toBe(true);
  });

  test('cleanupProcessedTasks removes entries older than 7 days but keeps recent ones', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.mkdirSync(path.dirname(processedTasksFile), { recursive: true });
    fs.writeFileSync(
      processedTasksFile,
      JSON.stringify({ 'old.ts': eightDaysAgo, 'recent.ts': Date.now() }),
      'utf8',
    );
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });

    bridgeState.cleanupProcessedTasks();

    expect(bridgeState.isTaskProcessed('old.ts')).toBe(false);
    expect(bridgeState.isTaskProcessed('recent.ts')).toBe(true);
  });

  test('corrupt processed-tasks file resets to empty', () => {
    fs.mkdirSync(path.dirname(processedTasksFile), { recursive: true });
    fs.writeFileSync(processedTasksFile, '[1,2,3]', 'utf8'); // wrong shape (array)
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridgeState.init({ stateFile, processedTasksFile, bridgeChannel: 'C_BRIDGE' });
    expect(bridgeState.isTaskProcessed('anything')).toBe(false);
    warnSpy.mockRestore();
  });
});
