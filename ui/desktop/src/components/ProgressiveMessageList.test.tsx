import { StrictMode } from 'react';
type Rect = ReturnType<HTMLElement['getBoundingClientRect']>;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ImageData, Message, MessageContent } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import ProgressiveMessageList from './ProgressiveMessageList';

const renderCounts = vi.hoisted(() => new Map<string, number>());
const messageUpdateCallbacks = vi.hoisted(
  () =>
    new Map<
      string,
      | ((
          messageId: string,
          newContent: string,
          editType: 'fork' | 'edit',
          retainedImages: ImageData[]
        ) => void)
      | undefined
    >()
);

vi.mock('./GooseMessage', () => ({
  default: ({ message }: { message: Message }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <div>{id}</div>;
  },
}));

vi.mock('./UserMessage', () => ({
  default: ({
    message,
    onMessageUpdate,
  }: {
    message: Message;
    onMessageUpdate?: (
      messageId: string,
      newContent: string,
      editType: 'fork' | 'edit',
      retainedImages: ImageData[]
    ) => void;
  }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    messageUpdateCallbacks.set(id, onMessageUpdate);
    return <div>{id}</div>;
  },
}));

const visibleMetadata: Message['metadata'] = { agentVisible: true, userVisible: true };
const append = vi.fn();
const isUserMessage = (message: Message) => message.role === 'user';

function message(id: string, role: Message['role'], content: MessageContent[]): Message {
  return { id, role, created: 1, content, metadata: visibleMetadata };
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((item) => ({
    ...item,
    content: item.content.map((content) => ({ ...content })),
    metadata: { ...item.metadata },
  }));
}

function toolRequest(id: string): MessageContent {
  return {
    type: 'toolRequest',
    id,
    toolCall: {
      status: 'success',
      value: { name: 'test_tool', arguments: {} },
    },
  };
}

function toolResponse(id: string): MessageContent {
  return {
    type: 'toolResponse',
    id,
    toolResult: {
      status: 'success',
      value: { content: [{ type: 'text', text: 'complete' }], isError: false },
    },
  };
}

function renderList(messages: Message[]) {
  return render(
    <ProgressiveMessageList
      messages={messages}
      sessionId="test-session"
      append={append}
      isUserMessage={isUserMessage}
    />,
    { wrapper: IntlTestWrapper }
  );
}

describe('ProgressiveMessageList render isolation', () => {
  beforeEach(() => {
    renderCounts.clear();
    messageUpdateCallbacks.clear();
    append.mockClear();
  });

  it('does not rerender historical rows from cloned equivalent messages', () => {
    const messages = [
      message('assistant-1', 'assistant', [{ type: 'text', text: 'First' }]),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      message('assistant-2', 'assistant', [{ type: 'text', text: 'Streaming' }]),
    ];
    const { rerender } = renderList(messages);

    rerender(
      <ProgressiveMessageList
        messages={cloneMessages(messages)}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts).toEqual(
      new Map([
        ['assistant-1', 1],
        ['user-1', 1],
        ['assistant-2', 1],
      ])
    );

    const updatedMessages = cloneMessages(messages);
    updatedMessages[2].content = [{ type: 'text', text: 'Streaming update' }];
    rerender(
      <ProgressiveMessageList
        messages={updatedMessages}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts).toEqual(
      new Map([
        ['assistant-1', 1],
        ['user-1', 1],
        ['assistant-2', 2],
      ])
    );
  });

  it('rerenders the matching request row when a tool response arrives', () => {
    const messages = [
      message('tool-request', 'assistant', [toolRequest('tool-1')]),
      message('unrelated', 'assistant', [{ type: 'text', text: 'Unrelated' }]),
      message('tool-response', 'user', []),
    ];
    const { rerender } = renderList(messages);
    const updatedMessages = cloneMessages(messages);
    updatedMessages[2].content = [toolResponse('tool-1')];

    rerender(
      <ProgressiveMessageList
        messages={updatedMessages}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts.get('tool-request')).toBe(2);
    expect(renderCounts.get('unrelated')).toBe(1);
  });

  it('preserves the message update callback', () => {
    const onMessageUpdate = vi.fn();
    render(
      <ProgressiveMessageList
        messages={[message('user-1', 'user', [{ type: 'text', text: 'Original' }])]}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
        onMessageUpdate={onMessageUpdate}
      />,
      { wrapper: IntlTestWrapper }
    );
    const retainedImages: ImageData[] = [{ data: 'image', mimeType: 'image/png' }];

    messageUpdateCallbacks.get('user-1')?.('user-1', 'Updated', 'fork', retainedImages);

    expect(onMessageUpdate).toHaveBeenCalledWith('user-1', 'Updated', 'fork', retainedImages);
  });
});

describe('ProgressiveMessageList history window', () => {
  const messages = Array.from({ length: 2230 }, (_, index) =>
    message(`assistant-${index}`, 'assistant', [{ type: 'text', text: `Message ${index}` }])
  );
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens at the latest messages immediately and does not expand on a timer', () => {
    const complete = vi.fn();
    render(
      <StrictMode>
        <IntlTestWrapper>
          <ProgressiveMessageList
            messages={messages}
            sessionId="large"
            isUserMessage={isUserMessage}
            onRenderingComplete={complete}
          />
        </IntlTestWrapper>
      </StrictMode>
    );
    expect(screen.queryByText('assistant-0')).not.toBeNull();
    expect(screen.queryByText('assistant-2229')).not.toBeNull();
    expect(screen.queryByText('assistant-20')).toBeNull();
    expect(screen.getAllByTestId('message-container')).toHaveLength(220);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getAllByTestId('message-container')).toHaveLength(220);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('expands older history only when requested without losing the latest row', () => {
    renderList(messages);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(screen.getAllByTestId('message-container')).toHaveLength(420);
    expect(screen.queryByText('assistant-1830')).not.toBeNull();
    expect(screen.queryByText('assistant-1829')).toBeNull();
    expect(screen.queryByText('assistant-2229')).not.toBeNull();
  });

  it.each(['darwin', 'linux'])('expands all history for search on %s', (platform) => {
    const originalPlatform = window.electron.platform;
    window.electron.platform = platform;
    renderList(messages);
    fireEvent.keyDown(window, {
      key: 'f',
      metaKey: platform === 'darwin',
      ctrlKey: platform !== 'darwin',
    });
    expect(screen.getAllByTestId('message-container')).toHaveLength(2230);
    expect(screen.queryByText('assistant-100')).not.toBeNull();
    window.electron.platform = originalPlatform;
  });

  it('resets an expanded window when changing sessions and includes new messages', () => {
    const { rerender } = renderList(messages);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    rerender(
      <ProgressiveMessageList
        messages={messages}
        sessionId="another"
        isUserMessage={isUserMessage}
      />
    );
    expect(screen.getAllByTestId('message-container')).toHaveLength(220);
    rerender(
      <ProgressiveMessageList
        messages={[...messages, message('newest', 'assistant', [])]}
        sessionId="another"
        isUserMessage={isUserMessage}
        isStreamingMessage
      />
    );
    expect(screen.queryByText('newest')).not.toBeNull();
    expect(screen.getAllByTestId('message-container')).toHaveLength(220);
  });

  it('preserves the scroll position when older rows are inserted', () => {
    let top = 100;
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => ({
        top,
        bottom: top,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: top,
        toJSON() {},
      }));
    const { container } = renderList(messages);
    container.style.overflowY = 'auto';
    container.scrollTop = 50;
    rect.mockImplementationOnce(() => ({ top: 100 }) as Rect);
    top = 300;
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(container.scrollTop).toBe(250);
    rect.mockRestore();
  });

  it('does not spend the window on invisible messages', () => {
    const hidden = messages.map((item) => ({
      ...item,
      metadata: { agentVisible: true, userVisible: false },
    }));
    renderList([...messages.slice(0, 10), ...hidden]);
    expect(screen.getAllByTestId('message-container')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });
});
