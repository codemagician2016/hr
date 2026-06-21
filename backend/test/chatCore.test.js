const {
  CHAT_CHANNELS,
  chatStorageKey,
  normalizeChannel,
  normalizeProjectKey,
  answerSelfHelp,
} = require('../src/lib/chat-core');

describe('chat core', () => {
  test('normalizes project and channel keys for reusable clients', () => {
    expect(normalizeProjectKey('Shop App!')).toBe('shop-app');
    expect(normalizeChannel('customer support')).toBe(CHAT_CHANNELS.CUSTOMER_SUPPORT);
    expect(chatStorageKey({ projectKey: 'Shop App!', tenantSlug: 'Demo-Store' }))
      .toBe('sitepresso-chat:shop-app:demo-store');
  });

  test('answers self help before escalating to a human chat', () => {
    const answer = answerSelfHelp('where is my order and delivery?');
    expect(answer.resolved).toBe(true);
    expect(answer.answer).toMatch(/My account/);

    const fallback = answerSelfHelp('completely unrelated mystery');
    expect(fallback.resolved).toBe(false);
    expect(fallback.answer).toMatch(/human support chat/);
  });
});
