import {
  beginChatInference,
  endChatInference,
  isChatInferenceActive,
  activeChatInferences,
  _resetChatInferenceStateForTests,
} from '../chat-inference-state';

describe('chat-inference-state', () => {
  beforeEach(() => _resetChatInferenceStateForTests());

  it('starts inactive', () => {
    expect(isChatInferenceActive()).toBe(false);
    expect(activeChatInferences()).toBe(0);
  });

  it('flips to active after beginChatInference', () => {
    beginChatInference();
    expect(isChatInferenceActive()).toBe(true);
    expect(activeChatInferences()).toBe(1);
  });

  it('handles concurrent chats via ref-counting', () => {
    beginChatInference();
    beginChatInference();
    expect(activeChatInferences()).toBe(2);

    endChatInference();
    expect(isChatInferenceActive()).toBe(true);
    expect(activeChatInferences()).toBe(1);

    endChatInference();
    expect(isChatInferenceActive()).toBe(false);
    expect(activeChatInferences()).toBe(0);
  });

  it('clamps the counter at zero on over-release', () => {
    endChatInference();
    endChatInference();
    expect(activeChatInferences()).toBe(0);
    expect(isChatInferenceActive()).toBe(false);
  });
});
