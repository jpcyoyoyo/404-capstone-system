import { describe, expect, it } from 'vitest';
import { commandError, commandRefusal, eventAction, plainDetail, waitText } from './codes';

describe('plain words for refused commands', () => {
  it('uses the controller sentence and keeps when to try again', () => {
    const r = commandRefusal('MIN_OFF_TIME', 'Grow lights: not switched on — it was switched off moments ago and has to stay off a little longer to protect it. Try again in 4 min 10 s.', 'Grow lights', 'ON');
    expect(r.title).toBe('Grow lights: not switched on');
    expect(r.text).toBe('It was switched off moments ago and has to stay off a little longer to protect it. Try again in 4 min 10 s.');
  });

  it('builds the words from the code for older or demo messages', () => {
    const r = commandRefusal('MIN_OFF_TIME', 'retry in 75 s', 'Exhaust fan', 'ON');
    expect(r.text).toBe('It was switched off moments ago and has to stay off a little longer to protect it. Try again in 1 min 15 s.');
    expect(commandRefusal('LOW_WATER', 'pump interlock: LOW_WATER', 'Irrigation', 'ON').text).toMatch(/^The reservoir water is too low/);
    expect(commandRefusal('STOCK_LOW', null, 'Dosing pump', 'DOSE').title).toBe('Dosing pump: dose not started');
  });

  it('never shows a bare code in the activity log', () => {
    expect(plainDetail('ON deferred: MIN_OFF_TIME (23 s)')).toBe('waiting to switch on: minimum off time, 23 s left');
    expect(plainDetail('pump interlock: LOW_WATER')).toBe('pump interlock: reservoir too low');
    expect(eventAction('CMD_ON')).toBe('command: on');
    expect(eventAction('SUPPRESSED')).toBe('held back');
  });

  it('explains send errors', () => {
    expect(commandError(403, 'administrator only')).toMatch(/^Only an administrator/);
    expect(commandError(0, 'Cannot reach the controller.')).toBe('Cannot reach the controller. Nothing was changed — check you are on the greenhouse network.');
    expect(waitText(300)).toBe('5 min');
  });
});
