'use strict';

/**
 * Gate 6R coexistence probe — a deliberately tiny Obsidian plugin.
 *
 * Gate 6R has to prove that the real peer editor can mutate the same canonical
 * files while Proxima is observing, and the reviewer's condition is precise: the
 * filesystem mutation must be executed by the running Obsidian process through its
 * `app.vault` API. A Node helper writing the same bytes does not qualify, because it
 * bypasses the abstraction whose behaviour is under test. The origin of the trigger
 * is not material — and the gate does not claim a human authored the edit.
 *
 * So this plugin exists to be the writer, and to be as close to nothing else as
 * possible. It has, deliberately:
 *
 *   no network and no fetch          no Node `fs` and no Electron
 *   no watcher and no timer          no user input and no arbitrary paths
 *   one hardcoded target             one mutation per load, then silence
 *
 * Each load advances one step of create → modify → delete and records completion in
 * its own plugin data. Obsidian both creates and removes the probe record, so
 * Proxima never touches it. The plugin is deleted from the vault after the run and
 * its removal verified; that cleanup is part of the gate, not housekeeping.
 *
 * Source of record lives in the Proxima repository under `tools/coexistence-probe/`.
 * It is copied into the vault only for the duration of a run.
 */

const { Plugin, TFile } = require('obsidian');

/** The only path this plugin will ever touch. Not configurable, by design. */
const PROBE_PATH = '-Hide/Proxima/events/proxima-6r-probe.md';

const CREATED_BODY = [
  '---',
  'id: proxima-6r-probe',
  'name: Proxima 6R coexistence probe',
  'startDate: 2026-09-07T09:00:00.000Z',
  'deadline: 2026-09-07T10:00:00.000Z',
  'createdAt: 2026-09-07T09:00:00.000Z',
  '---',
  '',
  'Written by the running Obsidian process through app.vault. Phase: created.',
  '',
].join('\n');

const MODIFIED_BODY = CREATED_BODY.replace(
  'Phase: created.',
  'Phase: modified by the peer editor.',
).replace('name: Proxima 6R coexistence probe', 'name: Proxima 6R coexistence probe (edited)');

/** create → modify → delete, one per load, then nothing. */
const STEPS = ['create', 'modify', 'delete', 'done'];

module.exports = class ProximaCoexistenceProbe extends Plugin {
  async onload() {
    // An explicit command exists so the operation can also be invoked deliberately.
    // Load-time execution is what makes the run unattended; both paths perform the
    // same single step, and the step guard keeps it one mutation either way.
    this.addCommand({
      id: 'proxima-6r-advance',
      name: 'Proxima 6R: perform the next probe mutation',
      callback: () => { void this.advance('command'); },
    });

    // Wait for the vault index before acting. At raw onload Obsidian has not
    // finished cataloguing the vault, so getAbstractFileByPath answers null for a
    // file that is plainly on disk — which sent the first real run down the create
    // path and straight into "File already exists." onLayoutReady is the ordinary
    // hook for "the vault is ready", not a watcher or a timer.
    this.app.workspace.onLayoutReady(() => { void this.advance('load'); });
  }

  /** Perform exactly one vault mutation and record what happened. */
  async advance(trigger) {
    const data = (await this.loadData()) || { step: 0, log: [] };
    const step = STEPS[data.step] || 'done';
    if (step === 'done') return;

    const record = (outcome, detail) => {
      data.log.push({ step, trigger, outcome, detail: detail || '', at: new Date().toISOString() });
      data.step += 1;
      return this.saveData(data);
    };

    try {
      const existing = this.app.vault.getAbstractFileByPath(PROBE_PATH);

      if (step === 'create') {
        if (existing instanceof TFile) {
          // Left over from an interrupted run: make the state deterministic without
          // performing an unrecorded extra mutation.
          await this.app.vault.modify(existing, CREATED_BODY);
          await record('ok', 'existing probe reset to the created state');
          return;
        }
        try {
          await this.app.vault.create(PROBE_PATH, CREATED_BODY);
          await record('ok', 'created through app.vault.create');
        } catch (error) {
          // The index can still disagree with the disk. If the file turns out to be
          // there, reset it to the created state rather than failing the step on a
          // discrepancy that says nothing about coexistence.
          const found = this.app.vault.getAbstractFileByPath(PROBE_PATH);
          if (!(found instanceof TFile)) throw error;
          await this.app.vault.modify(found, CREATED_BODY);
          await record('ok', 'existing probe reset to the created state after a create conflict');
        }
        return;
      }

      if (step === 'modify') {
        if (!(existing instanceof TFile)) {
          await record('skipped', 'probe record was not present to modify');
          return;
        }
        await this.app.vault.modify(existing, MODIFIED_BODY);
        await record('ok', 'modified through app.vault.modify');
        return;
      }

      if (step === 'delete') {
        if (!(existing instanceof TFile)) {
          await record('skipped', 'probe record was already absent');
          return;
        }
        // Obsidian removes what Obsidian created, so Proxima never writes.
        await this.app.vault.delete(existing);
        await record('ok', 'deleted through app.vault.delete');
        return;
      }
    } catch (error) {
      await record('error', String((error && error.message) || error).slice(0, 200));
    }
  }
};
