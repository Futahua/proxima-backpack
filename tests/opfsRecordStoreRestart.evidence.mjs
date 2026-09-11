import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BACKPACK_ID =
  'bp-954ea2cd-6261-410d-baf8-0d1fbd8ca0b1';

const BACKPACK_ORIGIN =
  `papers-backpack://${BACKPACK_ID}`;

const RECORD_ID =
  'pxr_000000000000000000000000000000f1';

const PROJECT_RECORD_ID =
  'pxr_000000000000000000000000000000f2';

const RECORD_NAME =
  'Stage 7 restart-retention disposable record';

const papersRootArgument = process.argv[2];
const proximaRootArgument = process.argv[3];

if (!papersRootArgument || !proximaRootArgument) {
  throw new Error(
    'Usage: node tests/opfsRecordStoreRestart.evidence.mjs <papers-root> <proxima-root>',
  );
}

const papersRoot =
  path.resolve(papersRootArgument);

const proximaRoot =
  path.resolve(proximaRootArgument);

const requireFromPapers =
  createRequire(
    path.join(
      papersRoot,
      'package.json',
    ),
  );

const {
  _electron: electron,
} = requireFromPapers(
  'playwright-core',
);

async function waitFor(
  probe,
  timeoutMs,
  label,
) {
  const deadline =
    Date.now() + timeoutMs;

  let lastError = null;

  while (Date.now() < deadline) {
    try {
      if (await probe()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, 250),
    );
  }

  throw new Error(
    `Timed out waiting for ${label}${
      lastError
        ? `: ${String(lastError)}`
        : ''
    }`,
  );
}

async function seedPapersProfile(
  userDataDir,
) {
  const dataDir =
    path.join(
      userDataDir,
      'PapersData',
    );

  const backpackDir =
    path.join(
      dataDir,
      'backpacks',
      BACKPACK_ID,
    );

  await fs.mkdir(
    backpackDir,
    {
      recursive: true,
    },
  );

  const backpack = {
    schemaVersion: 1,
    id: BACKPACK_ID,
    name: 'Proxima restart retention',
    type: 'environment',
    createdAt:
      '2026-09-11T00:00:00.000Z',
    lastEnteredAt: null,
    archived: false,
    workspacePath: null,
  };

  await fs.writeFile(
    path.join(
      dataDir,
      'registry.json',
    ),
    JSON.stringify(
      {
        schemaVersion: 1,
        backpacks: [
          backpack,
        ],
        lastActiveBackpackId: null,
      },
      null,
      2,
    ),
    'utf8',
  );

  await fs.writeFile(
    path.join(
      dataDir,
      'backpack-projects.json',
    ),
    JSON.stringify(
      {
        schemaVersion: 1,
        projects: {
          [BACKPACK_ID]: {
            root: proximaRoot,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  await fs.writeFile(
    path.join(
      backpackDir,
      'backpack.json',
    ),
    JSON.stringify(
      backpack,
      null,
      2,
    ),
    'utf8',
  );
}

async function launchPapers(
  userDataDir,
) {
  return electron.launch({
    args: [
      papersRoot,
    ],
    cwd: papersRoot,
    env: {
      ...process.env,
      PAPERS_TEST_USER_DATA:
        userDataDir,
      PAPERS_ENABLE_FIXTURES:
        '0',
      ELECTRON_ENABLE_LOGGING:
        '1',
    },
  });
}

async function projectIsOpen(
  app,
) {
  return app.evaluate(
    ({ webContents }, projectId) =>
      webContents
        .getAllWebContents()
        .some(
          (contents) =>
            contents
              .getURL()
              .startsWith(
                `papers-backpack://${projectId}/`,
              ),
        ),
    BACKPACK_ID,
  );
}

async function enterProject(
  app,
) {
  if (await projectIsOpen(app)) {
    return;
  }

  await waitFor(
    async () =>
      app.evaluate(
        async (
          { BaseWindow },
        ) => {
          const win =
            BaseWindow
              .getAllWindows()[0];

          if (!win) {
            return false;
          }

          const views =
            win.contentView.children;

          const host =
            views.find(
              (view) =>
                !view.webContents
                  .getURL()
                  .startsWith(
                    'papers-backpack://',
                  ),
            );

          if (!host) {
            return false;
          }

          return host.webContents
            .executeJavaScript(
              `Boolean(
                window.papersHost
                && window.papersHost.backpacks
                && typeof window.papersHost.backpacks.list === 'function'
                && window.papersHost.backpackProject
                && typeof window.papersHost.backpackProject.open === 'function'
              )`,
              true,
            );
        },
      ),
    10_000,
    'Papers host preload bridge',
  );

  const opened =
    await app.evaluate(
      async (
        { BaseWindow },
        projectId,
      ) => {
        const win =
          BaseWindow
            .getAllWindows()[0];

        if (!win) {
          throw new Error(
            'No Papers window exists.',
          );
        }

        const views =
          win.contentView.children;

        const host =
          views.find(
            (view) =>
              !view.webContents
                .getURL()
                .startsWith(
                  'papers-backpack://',
                ),
          );

        if (!host) {
          throw new Error(
            'No Papers host view exists.',
          );
        }

        return host.webContents
          .executeJavaScript(
            `(async () => {
              const list =
                await window.papersHost
                  .backpacks
                  .list();

              const seeded =
                list.backpacks.find(
                  (backpack) =>
                    backpack.id
                    === ${JSON.stringify(projectId)},
                );

              if (!seeded) {
                throw new Error(
                  'Seeded Proxima Backpack is absent from the Papers registry.'
                );
              }

              const opened =
                await window.papersHost
                  .backpackProject
                  .open(
                    ${JSON.stringify(projectId)}
                  );

              if (!opened) {
                throw new Error(
                  'Seeded Proxima Backpack has no bound project.'
                );
              }

              return {
                id: seeded.id,
                name: seeded.name,
                surfaceId:
                  opened.surfaceId,
                url:
                  opened.url,
              };
            })()`,
            true,
          );
      },
      BACKPACK_ID,
    );

  if (
    !opened
    || opened.id !== BACKPACK_ID
    || opened.name
      !== 'Proxima restart retention'
    || typeof opened.surfaceId
      !== 'string'
    || !opened.url
      .startsWith(
        `${BACKPACK_ORIGIN}/`,
      )
  ) {
    throw new Error(
      'Papers host did not open the exact seeded Proxima Backpack project.',
    );
  }

  await waitFor(
    () => projectIsOpen(app),
    10_000,
    'Proxima Backpack project surface',
  );
}

async function evalInProject(
  app,
  script,
) {
  return app.evaluate(
    async (
      { webContents },
      {
        projectId,
        expression,
      },
    ) => {
      const project =
        webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents
                .getURL()
                .startsWith(
                  `papers-backpack://${projectId}/`,
                ),
          );

      if (!project) {
        throw new Error(
          `No project WebContents for ${projectId}.`,
        );
      }

      return project
        .executeJavaScript(
          expression,
          true,
        );
    },
    {
      projectId: BACKPACK_ID,
      expression: script,
    },
  );
}

const createRecordExpression =
  `(async () => {
    const backendModule =
      await import(
        new URL(
          './build/adapters/opfsRecordStoreFileBackend.js',
          location.href,
        ).href
      );

    const storeModule =
      await import(
        new URL(
          './build/app/canonicalRecordCodec.js',
          location.href,
        ).href
      );

    const identityModule =
      await import(
        new URL(
          './build/domain/canonicalIdentity.js',
          location.href,
        ).href
      );

    const backend =
      await backendModule
        .createBrowserOpfsRecordStoreFileBackend();

    const store =
      storeModule
        .createCanonicalJsonRecordStore(
          backend,
        );

    const record = {
      schemaVersion:
        identityModule
          .CANONICAL_RECORD_SCHEMA_VERSION,
      kind: 'workflow-stage',
      id: ${JSON.stringify(RECORD_ID)},
      name: ${JSON.stringify(RECORD_NAME)},
      projectId:
        ${JSON.stringify(PROJECT_RECORD_ID)},
    };

    const created =
      await store.createIfAbsent(
        record,
      );

    if (!created.ok) {
      throw new Error(
        'Disposable canonical record was not created: '
          + JSON.stringify(created),
      );
    }

    const observed =
      await store.read(
        ${JSON.stringify(RECORD_ID)},
      );

    if (
      !observed
      || observed.record.id !== record.id
      || observed.record.kind !== record.kind
      || observed.record.name !== record.name
      || observed.record.projectId
        !== record.projectId
    ) {
      throw new Error(
        'Disposable canonical record did not reread before restart.',
      );
    }

    return {
      origin:
        location.protocol
          + '//'
          + location.host,
      createdRevision:
        created.revision,
      observedRevision:
        observed.observedRevision,
      record:
        observed.record,
    };
  })()`;

const rereadAndDeleteExpression =
  `(async () => {
    const backendModule =
      await import(
        new URL(
          './build/adapters/opfsRecordStoreFileBackend.js',
          location.href,
        ).href
      );

    const storeModule =
      await import(
        new URL(
          './build/app/canonicalRecordCodec.js',
          location.href,
        ).href
      );

    const backend =
      await backendModule
        .createBrowserOpfsRecordStoreFileBackend();

    const store =
      storeModule
        .createCanonicalJsonRecordStore(
          backend,
        );

    const observed =
      await store.read(
        ${JSON.stringify(RECORD_ID)},
      );

    if (!observed) {
      throw new Error(
        'Disposable canonical record was absent after Papers restart.',
      );
    }

    if (
      observed.record.schemaVersion !== 2
      || observed.record.kind
        !== 'workflow-stage'
      || observed.record.id
        !== ${JSON.stringify(RECORD_ID)}
      || observed.record.name
        !== ${JSON.stringify(RECORD_NAME)}
      || observed.record.projectId
        !== ${JSON.stringify(PROJECT_RECORD_ID)}
    ) {
      throw new Error(
        'Canonical record changed across Papers restart: '
          + JSON.stringify(
            observed.record,
          ),
      );
    }

    const deleted =
      await store.deleteIfUnchanged(
        ${JSON.stringify(RECORD_ID)},
        observed.observedRevision,
      );

    if (!deleted.ok) {
      throw new Error(
        'Disposable canonical record cleanup failed: '
          + JSON.stringify(deleted),
      );
    }

    const afterDelete =
      await store.read(
        ${JSON.stringify(RECORD_ID)},
      );

    if (afterDelete !== undefined) {
      throw new Error(
        'Disposable canonical record remained after cleanup.',
      );
    }

    return {
      origin:
        location.protocol
          + '//'
          + location.host,
      observedRevision:
        observed.observedRevision,
      record:
        observed.record,
      deleted: true,
    };
  })()`;

const userDataDir =
  await fs.mkdtemp(
    path.join(
      os.tmpdir(),
      'proxima-opfs-restart-',
    ),
  );

let firstApp = null;
let secondApp = null;
let evidence = null;

try {
  await seedPapersProfile(
    userDataDir,
  );

  firstApp =
    await launchPapers(
      userDataDir,
    );

  const firstPid =
    await firstApp.evaluate(
      () => process.pid,
    );

  await enterProject(
    firstApp,
  );

  const beforeRestart =
    await evalInProject(
      firstApp,
      createRecordExpression,
    );

  if (
    beforeRestart.origin
    !== BACKPACK_ORIGIN
  ) {
    throw new Error(
      `Unexpected first-launch origin: ${beforeRestart.origin}`,
    );
  }

  await firstApp.close();
  firstApp = null;

  secondApp =
    await launchPapers(
      userDataDir,
    );

  const secondPid =
    await secondApp.evaluate(
      () => process.pid,
    );

  if (secondPid === firstPid) {
    throw new Error(
      'Papers restart evidence did not cross to a new process.',
    );
  }

  await enterProject(
    secondApp,
  );

  const afterRestart =
    await evalInProject(
      secondApp,
      rereadAndDeleteExpression,
    );

  if (
    afterRestart.origin
    !== BACKPACK_ORIGIN
  ) {
    throw new Error(
      `Unexpected second-launch origin: ${afterRestart.origin}`,
    );
  }

  evidence = {
    ok: true,
    boundary:
      'real-papers-close-and-new-electron-launch',
    userDataReused: true,
    firstPid,
    secondPid,
    processChanged:
      firstPid !== secondPid,
    originBeforeRestart:
      beforeRestart.origin,
    originAfterRestart:
      afterRestart.origin,
    recordId:
      RECORD_ID,
    kind:
      afterRestart.record.kind,
    name:
      afterRestart.record.name,
    projectId:
      afterRestart.record.projectId,
    createdRevision:
      beforeRestart.createdRevision,
    preRestartObservedRevision:
      beforeRestart.observedRevision,
    postRestartObservedRevision:
      afterRestart.observedRevision,
    exactCanonicalRecordRetained:
      true,
    disposableRecordDeleted:
      afterRestart.deleted,
  };
} finally {
  if (firstApp) {
    await firstApp.close();
  }

  if (secondApp) {
    await secondApp.close();
  }

  await fs.rm(
    userDataDir,
    {
      recursive: true,
      force: true,
    },
  );
}

if (!evidence) {
  throw new Error(
    'Restart-retention evidence was not produced.',
  );
}

console.log(
  JSON.stringify(
    evidence,
    null,
    2,
  ),
);
