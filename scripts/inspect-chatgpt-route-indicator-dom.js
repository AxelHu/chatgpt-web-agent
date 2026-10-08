// Read-only company-side acceptance probe. Evaluate in the target ChatGPT tab.
// Returns structural counts and this userscript's labels only: no conversation
// text, raw message IDs, URL, cookies, storage, API calls, or outbound requests.
(() => {
  const host = document.getElementById('chatgpt-route-indicator-host');
  const pill = host?.shadowRoot?.getElementById('pill');
  const badges = [...document.querySelectorAll('[data-chatgpt-actual-route="true"]')];
  const count = (selector) => document.querySelectorAll(selector).length;
  const idsLength = (value) => { try { const ids=JSON.parse(value || '[]'); return Array.isArray(ids) ? ids.length : null; } catch { return null; } };
  const listFormats = [...document.querySelectorAll('[data-chatgpt-search-message-ids]')].map((node) => {
    const value = node.getAttribute('data-chatgpt-search-message-ids') || '';
    let format = 'delimited';
    try { const v = JSON.parse(value); format = Array.isArray(v) ? 'JSON array' : typeof v === 'string' ? 'JSON string' : 'unsupported JSON'; }
    catch { if (/^[\["{]/.test(value.trim())) format = 'malformed JSON'; }
    return format;
  });
  return {
    scriptVersion: host?.dataset.scriptVersion || null,
    counts: {
      assistantRole: count('[data-conversation-role="assistant"]'),
      turnKeys: count('[data-turn-key]'),
      turnStartMarkers: count('[data-chatgpt-agent-turn-start]'),
      searchIdLists: listFormats.length,
      userBubbles: count('[data-user-message-bubble="true"]'),
      inlineBadges: badges.length,
      badgesInsideUserBubbles: count('[data-user-message-bubble="true"] [data-chatgpt-actual-route="true"]'),
    },
    listFormats: Object.fromEntries([...new Set(listFormats)].map((format) => [format, listFormats.filter((value) => value === format).length])),
    focused: { label: pill?.textContent || null, assistantIdCount: idsLength(pill?.dataset.focusedMessageIds) },
    badges: badges.map((node, index) => {
      const rect = node.getBoundingClientRect();
      return { index, binding: node.dataset.routeBinding || null,
        matchedAssistantIds: idsLength(node.dataset.routeMessageIds),
        unmatchedIds: Number(node.dataset.routeUnmatchedCount || 0), invalidLists: Number(node.dataset.routeInvalidLists || 0),
        label: node.textContent, hasLayoutBox: rect.width > 0 && rect.height > 0,
        insideKeyedTurn: Boolean(node.closest('[data-turn-key]')),
      };
    }),
  };
})()
