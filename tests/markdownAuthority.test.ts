import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../src/adapters/memoryVault.js';
import { loadVaultState } from '../src/app/vaultRepository.js';
import { sequentialIdGenerator } from '../src/domain/clock.js';
import { admitCanvasDrop, renderCanvasSurface } from '../src/browser/canvasSurface.js';
import type { BrowserFileLike } from '../src/browser/canvasFileAdmission.js';
import { createCanvasTextPreviewRegistry } from '../src/browser/canvasTextPreview.js';

const hostileMarkdown = [
  '<script>fetch("https://evil.invalid")</script>',
  '<img src="file:///etc/passwd" onerror="fetch(\'https://evil.invalid\')">',
  '[run](javascript:alert(1))',
  '[bridge](http://127.0.0.1:4174/read?path=/etc/passwd)',
].join('\n');

function browserFile(name: string, text: string): BrowserFileLike {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.length,
    lastModified: 0,
    type: 'text/markdown',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe('Gate 20F untrusted Markdown authority boundary', () => {
  it('keeps hostile Markdown as data from record load through browser presentation', async () => {
    const loaded = await loadVaultState(createMemoryVault({
      'Proxima/projects/Hostile.md': `---\nname: Hostile\n---\n${hostileMarkdown}`,
    }));
    expect(loaded.state.projects[0]?.description).toBe(hostileMarkdown);

    const textPreviews = createCanvasTextPreviewRegistry();
    const state = await admitCanvasDrop(
      [browserFile('Hostile.md', hostileMarkdown)],
      undefined,
      sequentialIdGenerator(),
      undefined,
      undefined,
      textPreviews,
    );
    const html = renderCanvasSurface(state, undefined, undefined, textPreviews.snapshot());

    expect(html).toContain('&lt;script&gt;fetch(&quot;https://evil.invalid&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=&quot;file:///etc/passwd&quot; onerror=&quot;fetch(&#39;https://evil.invalid&#39;)&quot;&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img ');
    expect(html).toContain('[run](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('arrayBuffer');
    expect(JSON.stringify(state)).not.toContain('fetch(');
  });
});
