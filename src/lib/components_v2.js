'use strict';
// Shared Discord Components V2 renderer. Keep some room for role mentions.
const IS_COMPONENTS_V2_FLAG = 1 << 15;
const TEXT_DISPLAY_MAX = 4000;
const CONTAINER_MAX_COMPONENTS = 10;
const MESSAGE_MAX_COMPONENTS = 40;
const MESSAGE_MAX_TEXT_CHARS = 3900;

function componentTextLen(comp) {
  if (!comp || typeof comp !== 'object') return 0;
  let n = comp.type === 10 && typeof comp.content === 'string' ? comp.content.length : 0;
  if (Array.isArray(comp.components)) for (const child of comp.components) n += componentTextLen(child);
  return n + (comp.accessory ? componentTextLen(comp.accessory) : 0);
}

function textDisplay(content) {
  const str = String(content);
  return { type: 10, content: str.length <= TEXT_DISPLAY_MAX ? str : str.slice(0, TEXT_DISPLAY_MAX - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…' };
}
function separator(divider = true, spacing = 1) { return { type: 14, divider, spacing }; }
function container(components, accentColor) {
  const c = { type: 17, components };
  if (accentColor != null) c.accent_color = accentColor;
  return c;
}
function mediaGalleryFromUrls(urls) {
  const items = [], seen = new Set();
  for (const u of urls || []) {
    if (typeof u !== 'string') continue;
    const url = u.trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    items.push({ media: { url: url.slice(0, 2048) } });
    if (items.length >= 4) break;
  }
  return items.length ? { type: 12, items } : null;
}
function embedImageUrls(embed) { return [embed?.image?.url, embed?.thumbnail?.url].filter(Boolean); }
function linkButton(label, url) {
  return { type: 2, style: 5, label: String(label).slice(0, 80), url: String(url).slice(0, 512) };
}
function dismissButton(label = 'Dismiss') { return { type: 1, components: [linkButton(label, 'https://discord.com')] }; }
// Kept for API compatibility. No notification receives a Dismiss button.
function addDismissToMessages(messages) { return messages; }

function chunkText(text, maxLen = TEXT_DISPLAY_MAX) {
  if (!Number.isSafeInteger(maxLen) || maxLen < 1) throw new RangeError('maxLen must be a positive integer');
  const str = String(text || '');
  if (str.length <= maxLen) return [str];
  const chunks = [];
  for (let pos = 0; pos < str.length;) {
    let end = Math.min(str.length, pos + maxLen);
    if (end < str.length) {
      const window = str.slice(Math.max(pos, end - 200), end);
      let at = window.lastIndexOf('\n');
      if (at < 0) at = window.lastIndexOf(' ');
      if (at >= 0) end -= window.length - at - 1;
      else if (end - pos > 1 && /[\uD800-\uDBFF]/u.test(str[end - 1]) && /[\uDC00-\uDFFF]/u.test(str[end])) end--;
    }
    chunks.push(str.slice(pos, end));
    pos = end;
  }
  return chunks;
}

function chunkIntoMessages(components, accentColor) {
  const messages = [];
  let current = [], chars = 0;
  for (const comp of components) {
    const parts = comp?.type === 10 && comp.content?.length > MESSAGE_MAX_TEXT_CHARS
      ? chunkText(comp.content, MESSAGE_MAX_TEXT_CHARS).map(textDisplay) : [comp];
    for (const part of parts) {
      const size = componentTextLen(part);
      if (current.length && (current.length >= CONTAINER_MAX_COMPONENTS || chars + size > MESSAGE_MAX_TEXT_CHARS)) {
        messages.push([container(current, accentColor)]);
        current = []; chars = 0;
      }
      if (!current.length && part?.type === 14) continue;
      current.push(part);
      chars += size;
    }
  }
  if (current.length) messages.push([container(current, accentColor)]);
  return messages;
}

function appendText(components, text) {
  for (const part of chunkText(text, MESSAGE_MAX_TEXT_CHARS)) components.push(textDisplay(part));
}
function buildSectionMessages({ bn, sections }) {
  const components = [];
  for (const sec of sections) {
    if (!sec.lines?.length) continue;
    if (components.length) components.push(separator());
    const count = sec.count ?? sec.lines.length;
    const build = bn == null || bn === '' ? '' : `Build ${bn} · `;
    appendText(components, `### ${sec.label}\n${build}**${count} élément${count > 1 ? 's' : ''}**`);
    appendText(components, sec.lines.join('\n'));
  }
  return chunkIntoMessages(components, sections.find(s => s.color != null)?.color);
}

function appendEmbed(components, embed, separateFooter) {
  const header = [];
  if (embed.author?.name) header.push(`**${embed.author.name}**`);
  if (embed.title) header.push(`## ${embed.title}`);
  if (typeof embed.url === 'string' && /^https?:\/\//i.test(embed.url)) {
    try {
      const url = new URL(embed.url);
      if (!url.username && !url.password) header.push(`-# Source : <${url.href}>`);
    } catch { /* A malformed source must not discard the notification. */ }
  }
  if (header.length) appendText(components, header.join('\n'));
  const gallery = mediaGalleryFromUrls(embedImageUrls(embed));
  if (gallery) components.push(gallery);
  if (embed.description) appendText(components, embed.description);
  for (const field of embed.fields || []) {
    appendText(components, field.name ? `**${field.name}**\n${field.value || ''}` : String(field.value || ''));
  }
  if (embed.footer?.text) {
    if (separateFooter && components.length) components.push(separator(false));
    appendText(components, `-# ${embed.footer.text}`);
  }
}
function embedToComponents(embed) {
  const components = [];
  appendEmbed(components, embed, true);
  return chunkIntoMessages(components.length ? components : [textDisplay(' ')], embed.color);
}
function embedsToComponents(embeds) {
  const components = [];
  for (const [i, embed] of embeds.entries()) {
    if (i) components.push(separator(true, 2));
    appendEmbed(components, embed, false);
  }
  return chunkIntoMessages(components.length ? components : [textDisplay(' ')], embeds.find(e => e?.color != null)?.color);
}
module.exports = {
  IS_COMPONENTS_V2_FLAG, TEXT_DISPLAY_MAX, CONTAINER_MAX_COMPONENTS, MESSAGE_MAX_COMPONENTS, MESSAGE_MAX_TEXT_CHARS,
  componentTextLen, textDisplay, separator, container, mediaGalleryFromUrls, embedImageUrls, linkButton, dismissButton,
  addDismissToMessages, chunkText, chunkIntoMessages, buildSectionMessages, embedToComponents, embedsToComponents,
};
