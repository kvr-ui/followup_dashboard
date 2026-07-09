import { useState } from 'react';

export default function CopyButton({ text, title = 'Copy' }) {
  const [copied, setCopied] = useState(false);

  async function copy(e) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copied' : ''}`}
      onClick={copy}
      title={title}
    >
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}
