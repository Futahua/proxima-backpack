/**
 * The probe's answers, in a file rather than inline: Papers serves Backpack pages under
 * `script-src <origin>` with no `'unsafe-inline'`, so an inline module is refused and this
 * script would never run. That refusal is the first containment result, and it is why the
 * product's own page loads its shell the same way.
 *
 * Each answer becomes a semantic key of the form `probe-<question>-<answer>`, which is the one
 * vocabulary a Papers host reads back, so the host's own `inspect.visual.elements` carries the
 * result of the probe rather than this page claiming it in prose.
 */
const answers = {};

// 1. No Node, in a page a host launches with sandbox + context isolation.
answers.node = (typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined')
  ? 'no-node'
  : 'NODE-VISIBLE';

// 2. Same-origin fetch: only a policy can refuse this, so a refusal is the CSP talking.
//    Cross-origin would be refused by CORS on any page, which is why the target is same-origin.
try {
  const response = await fetch('./probe.js', { cache: 'no-store' });
  answers.fetch = response.ok ? 'FETCH-ALLOWED' : `fetch-status-${response.status}`;
} catch {
  answers.fetch = 'fetch-blocked';
}

// 3. Indirect eval, which 'unsafe-eval' would permit.
try {
  answers.eval = (0, eval)('1 + 1') === 2 ? 'EVAL-ALLOWED' : 'eval-odd';
} catch {
  answers.eval = 'eval-blocked';
}

// 4. An embedded frame, same-origin so the refusal cannot be blamed on the far side. Neither a
//    load event nor a null document settles it: the question is whether the frame's document was
//    ever fetched, and resource timing answers that with a fact rather than an inference. (This
//    document's own load is a navigation entry, not a resource one, so any /index.html resource
//    entry can only come from the frame.) Only this top-level page probes, so an allowed frame
//    cannot turn the probe into a recursion.
answers.frame = 'frame-unmeasured';
if (window.top === window.self) {
  await new Promise((settle) => {
    const frame = document.createElement('iframe');
    let loaded = false;
    frame.addEventListener('load', () => { loaded = true; setTimeout(() => settle(), 150); });
    frame.src = './index.html';
    frame.style.display = 'none';
    document.body.append(frame);
    setTimeout(() => settle(), 1200);
  });
  const frame = document.querySelector('iframe[src="./index.html"]');
  const fetched = performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('/index.html')).length;
  let readable = false;
  try {
    readable = Boolean(frame?.contentDocument?.documentElement?.textContent?.includes('Containment probe'));
  } catch {
    readable = false;
  }
  const context = frame?.contentWindow !== null && frame?.contentWindow !== undefined;
  answers.frame = fetched === 0 && !readable
    ? 'frame-blocked'
    : readable
      ? 'frame-embedded_same-document'
      : `frame-embedded_fetched-${fetched}_context-${context ? 'present' : 'absent'}`;
}

// 5. Which origin is this, and whose storage can it see? The answer is a verdict rather than a
//    list, so the assertion is about isolation instead of about a string that changes as this
//    origin writes its own databases.
answers.origin = location.origin;
try {
  const databases = await indexedDB.databases();
  const names = databases.map((entry) => entry.name ?? '').filter(Boolean).sort();
  const foreign = names.filter((name) => name !== 'probe-own-database');
  answers.storage = foreign.length === 0 ? 'storage-isolated' : `storage-sees_${foreign.join('+')}`;
} catch {
  answers.storage = 'storage-unavailable';
}

// 6. Storage this origin writes stays on its own origin-scoped database.
try {
  indexedDB.open('probe-own-database', 1);
  answers.ownWrite = 'own-database-opened';
} catch {
  answers.ownWrite = 'own-database-refused';
}

/**
 * 7. The native-source handoff, from the side a page can reach without a real OS drop.
 *
 * Papers' production preload accepts three page messages - `native-source-grant` (which takes
 * exactly one `File` and resolves its disk path itself), `native-source-open` and
 * `native-source-reveal` (which take an opaque granted reference). Granting needs an
 * OS-backed `File`, so a *positive* open cannot be measured without a drag-and-drop by a
 * person; every *refusal* can be measured, and the refusals are what the handoff's
 * authorization rests on. Each attempt records the host's own answer, not this page's opinion.
 */
const hostAnswer = (message) => new Promise((settle) => {
  const requestId = `probe-${Math.random().toString(16).slice(2)}`;
  const onResult = (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'papers:host:result' || data.requestId !== requestId) return;
    window.removeEventListener('message', onResult);
    settle({ answered: true, ok: data.ok === true, error: typeof data.error === 'string' ? data.error.slice(0, 80) : null });
  };
  window.addEventListener('message', onResult);
  window.postMessage({ ...message, requestId }, window.location.origin);
  setTimeout(() => { window.removeEventListener('message', onResult); settle({ answered: false, ok: false, error: 'no host answer within 3000ms' }); }, 3000);
});

const handoff = {};
// A page-made File is not disk-backed: the host resolves paths itself, so this must be refused.
handoff.fabricated = await hostAnswer({ type: 'papers:project:native-source-grant', files: [new File(['probe'], 'probe.txt', { type: 'text/plain' })] });
// A reference nobody granted must not open anything.
const ungranted = '00000000-0000-4000-8000-000000000000';
handoff.ungranted = await hostAnswer({ type: 'papers:project:native-source-open', sourceRef: ungranted });
// A machine path is not a reference: the preload's own shape check must refuse it.
handoff.machinePath = await hostAnswer({ type: 'papers:project:native-source-reveal', sourceRef: 'C:\\Windows\\win.ini' });
// And neither is a non-reference string.
handoff.malformed = await hostAnswer({ type: 'papers:project:native-source-open', sourceRef: 'not-a-reference' });
for (const [name, answer] of Object.entries(handoff)) {
  // `no-answer` is a verdict of its own: silence is not a refusal, and reporting it as one would
  // turn an unimplemented handler into evidence of authorization.
  answers[`handoff-${name}`] = answer.answered ? (answer.ok ? 'ACCEPTED' : 'refused') : 'no-answer';
}
answers['handoff-answers'] = Object.entries(handoff)
  .map(([name, answer]) => `${name}:${answer.answered ? (answer.ok ? 'accepted' : 'refused') : 'no-answer'}`)
  .join('_')
  .replace(/[^A-Za-z0-9._~-]/g, '_')
  .slice(0, 80);

const safe = (value) => String(value).replace(/[^A-Za-z0-9._~-]/g, '_').slice(0, 80);
const host = document.querySelector('#answers');
for (const [question, answer] of Object.entries(answers)) {
  const key = document.createElement('span');
  key.setAttribute('data-papers-visual-key', `probe-${question}-${safe(answer)}`);
  key.textContent = `${question}: ${answer}`;
  host.append(key, document.createTextNode(' '));
}
document.querySelector('#report').textContent = Object.entries(answers)
  .map(([question, answer]) => `${question.padEnd(8)} ${answer}`)
  .join('\n');
