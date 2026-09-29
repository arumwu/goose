import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isEqual } from 'lodash';
import { defineMessages, useIntl } from '../i18n';
import GooseMessage from './GooseMessage';
import UserMessage from './UserMessage';
import {
  SystemNotificationInline,
  getInlineSystemNotification,
} from './context_management/SystemNotificationInline';
import {
  CreditsExhaustedNotification,
  getCreditsExhaustedNotification,
} from './context_management/CreditsExhaustedNotification';
import type {
  ImageData,
  Message,
  NotificationEvent,
  SystemNotificationContent,
} from '../types/message';
import { getModelDisplayName } from './settings/models/predefinedModelsUtils';
import { deriveMessageRowContexts, type MessageRowContext } from './messageRowContext';

const i18n = defineMessages({
  hiddenMessages: {
    id: 'progressiveMessageList.hiddenMessages',
    defaultMessage: '{count} earlier messages hidden for performance',
  },
  loadEarlier: {
    id: 'progressiveMessageList.loadEarlier',
    defaultMessage: 'Load earlier messages',
  },
  modelChanged: {
    id: 'progressiveMessageList.modelChanged',
    defaultMessage: 'Model changed: {previousModel} → {currentModel}',
  },
});

const emptyToolCallNotifications = new Map<string, NotificationEvent[]>();
const emptyAppend = () => {};

function getResolvedModel(message: Message): string | null {
  if (message.role !== 'assistant' || !message.metadata.userVisible) return null;
  return message.metadata.inference?.resolvedModel ?? null;
}

function getSystemNotification(message: Message): SystemNotificationContent | undefined {
  return getCreditsExhaustedNotification(message) ?? getInlineSystemNotification(message);
}

function renderSystemNotification(notification: SystemNotificationContent) {
  switch (notification.notificationType) {
    case 'creditsExhausted':
      return <CreditsExhaustedNotification notification={notification} />;
    case 'inlineMessage':
      return <SystemNotificationInline notification={notification} />;
    default:
      return null;
  }
}

interface MessageRowProps {
  append: (value: string) => void;
  index: number;
  isStreaming: boolean;
  isUser: boolean;
  message: Message;
  modelChangeMessage: string | null;
  onMessageUpdate?: (
    messageId: string,
    newContent: string,
    editType: 'fork' | 'edit',
    retainedImages: ImageData[]
  ) => void;
  rowContext: MessageRowContext;
  sessionId: string;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
  toolNotifications: readonly (NotificationEvent[] | undefined)[];
}

function MessageRowComponent({
  append,
  index,
  isStreaming,
  isUser,
  message,
  modelChangeMessage,
  onMessageUpdate,
  rowContext,
  sessionId,
  submitElicitationResponse,
  toolNotifications,
}: MessageRowProps) {
  const notification = getSystemNotification(message);

  if (notification) {
    return (
      <div
        className={`relative ${index === 0 ? 'mt-0' : 'mt-4'} assistant`}
        data-testid="message-container"
      >
        {renderSystemNotification(notification)}
      </div>
    );
  }

  const hasOnlyToolResponses = message.content.every((content) => content.type === 'toolResponse');

  return (
    <Fragment>
      {modelChangeMessage && (
        <SystemNotificationInline
          notification={{
            msg: modelChangeMessage,
            notificationType: 'inlineMessage',
          }}
        />
      )}
      <div
        className={`relative ${index === 0 ? 'mt-0' : 'mt-4'} ${isUser ? 'user' : 'assistant'} ${rowContext.isInToolCallChain ? 'in-chain' : ''}`}
        data-testid="message-container"
      >
        {isUser ? (
          !hasOnlyToolResponses && (
            <UserMessage message={message} onMessageUpdate={onMessageUpdate} />
          )
        ) : (
          <GooseMessage
            sessionId={sessionId}
            message={message}
            hideTimestamp={rowContext.hideTimestamp}
            toolStates={rowContext.toolStates}
            toolNotifications={toolNotifications}
            toolConfirmationShownInline={rowContext.toolConfirmationShownInline}
            append={append}
            isStreaming={isStreaming}
            submitElicitationResponse={submitElicitationResponse}
          />
        )}
      </div>
    </Fragment>
  );
}

const MessageRow = memo(MessageRowComponent, isEqual);

interface ProgressiveMessageListProps {
  messages: Message[];
  sessionId: string;
  toolCallNotifications?: Map<string, NotificationEvent[]>;
  append?: (value: string) => void;
  isUserMessage: (message: Message) => boolean;
  renderMessage?: (message: Message, index: number) => React.ReactNode | null;
  isStreamingMessage?: boolean;
  onMessageUpdate?: (
    messageId: string,
    newContent: string,
    editType: 'fork' | 'edit',
    retainedImages: ImageData[]
  ) => void;
  onRenderingComplete?: () => void;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
}

export default function ProgressiveMessageList({
  messages,
  sessionId,
  toolCallNotifications = emptyToolCallNotifications,
  append = emptyAppend,
  isUserMessage,
  renderMessage,
  isStreamingMessage = false,
  onMessageUpdate,
  onRenderingComplete,
  submitElicitationResponse,
}: ProgressiveMessageListProps) {
  const intl = useIntl();
  const [historyWindow, setHistoryWindow] = useState({ sessionId, extra: 0, all: false });
  const windowState =
    historyWindow.sessionId === sessionId ? historyWindow : { sessionId, extra: 0, all: false };
  if (historyWindow.sessionId !== sessionId) {
    setHistoryWindow(windowState);
  }
  const completedMessageKeyRef = useRef<string | null>(null);
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const anchorPositionRef = useRef<number | null>(null);
  const visibleIndices = useMemo(
    () => messages.flatMap((message, index) => (message.metadata.userVisible ? [index] : [])),
    [messages]
  );
  const tailStart = windowState.all
    ? 0
    : Math.max(20, visibleIndices.length - 200 - windowState.extra);
  const hiddenCount = Math.max(0, tailStart - 20);

  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    const previousTop = anchorPositionRef.current;
    if (!anchor || previousTop === null) return;
    anchorPositionRef.current = null;
    const delta = anchor.getBoundingClientRect().top - previousTop;
    let parent = anchor.parentElement;
    while (parent) {
      if (['auto', 'scroll'].includes(window.getComputedStyle(parent).overflowY)) {
        parent.scrollTop += delta;
        break;
      }
      parent = parent.parentElement;
    }
  }, [windowState.extra]);

  useEffect(() => {
    const completedMessageKey = `${sessionId}:${messages.length}`;
    if (completedMessageKeyRef.current === completedMessageKey) return;
    const timeout = window.setTimeout(() => {
      completedMessageKeyRef.current = completedMessageKey;
      onRenderingComplete?.();
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [messages.length, onRenderingComplete, sessionId]);

  useEffect(() => {
    if (hiddenCount === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = window.electron.platform === 'darwin';
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key === 'f') {
        setHistoryWindow({ sessionId, extra: 0, all: true });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hiddenCount, sessionId]);

  const rowContexts = useMemo(() => deriveMessageRowContexts(messages), [messages]);
  const messageRows = visibleIndices
    .map((index, visibleIndex) => {
      if (hiddenCount > 0 && visibleIndex >= 20 && visibleIndex < tailStart) return null;
      const message = messages[index];

      const isUser = isUserMessage(message);
      const messageIdentifier = message.id ?? `msg-${index}-${message.created}`;
      const messageKey = getSystemNotification(message)
        ? `notification-${messageIdentifier}`
        : messageIdentifier;
      const rowContext = rowContexts[index];
      const currentResolvedModel = getResolvedModel(message);
      const modelChangeMessage =
        currentResolvedModel &&
        rowContext.previousResolvedModel &&
        currentResolvedModel !== rowContext.previousResolvedModel
          ? intl.formatMessage(i18n.modelChanged, {
              previousModel: getModelDisplayName(rowContext.previousResolvedModel),
              currentModel: getModelDisplayName(currentResolvedModel),
            })
          : null;
      const toolNotifications = rowContext.toolStates.map((toolState) =>
        toolCallNotifications.get(toolState.requestId)
      );

      return (
        <Fragment key={messageKey}>
          {visibleIndex === tailStart && hiddenCount > 0 && (
            <div className="py-4 text-center text-text-secondary">
              <p>{intl.formatMessage(i18n.hiddenMessages, { count: hiddenCount })}</p>
              <button
                type="button"
                className="underline hover:text-text-primary"
                onClick={() => {
                  anchorPositionRef.current =
                    historyAnchorRef.current?.getBoundingClientRect().top ?? null;
                  setHistoryWindow({ sessionId, extra: windowState.extra + 200, all: false });
                }}
              >
                {intl.formatMessage(i18n.loadEarlier)}
              </button>
            </div>
          )}
          {visibleIndex === visibleIndices.length - 1 && <div ref={historyAnchorRef} />}
          {renderMessage ? (
            renderMessage(message, index)
          ) : (
            <MessageRow
              key={messageKey}
              append={append}
              index={index}
              isStreaming={
                isStreamingMessage &&
                !isUser &&
                index === messages.length - 1 &&
                message.role === 'assistant'
              }
              isUser={isUser}
              message={message}
              modelChangeMessage={modelChangeMessage}
              onMessageUpdate={onMessageUpdate}
              rowContext={rowContext}
              sessionId={sessionId}
              submitElicitationResponse={submitElicitationResponse}
              toolNotifications={toolNotifications}
            />
          )}
        </Fragment>
      );
    })
    .filter(Boolean);

  return <>{messageRows}</>;
}
