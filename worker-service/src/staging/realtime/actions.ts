import {
  combineRealtimeOutcomes,
  noopRealtimeOutcome,
  pickRealtimePeer
} from './support.js';
import {
  sendActiveContext,
  sendGroupMessage,
  sendPresenceSubscribe,
  sendPrivateMessage
} from './packets.js';
import type {
  RealtimeOutcome,
  RealtimeSessionState,
  StagingRealtimeInput
} from './types.js';

export class StagingRealtimeActionHandlers {
  async handle(input: StagingRealtimeInput, session: RealtimeSessionState): Promise<RealtimeOutcome> {
    switch (input.action) {
      case 'login':
        return combineRealtimeOutcomes(
          await sendPresenceSubscribe(input, session),
          await sendActiveContext(session, '/', null)
        );
      case 'open_home':
        return sendActiveContext(session, '/', null);
      case 'fetch_notifications':
      case 'open_notifications':
        return sendActiveContext(session, '/notifications', null);
      case 'fetch_friends':
        return combineRealtimeOutcomes(
          await sendPresenceSubscribe(input, session),
          await sendActiveContext(session, '/friends', null)
        );
      case 'open_private_conversation':
        session.currentPeerId = pickRealtimePeer(input)?.id ?? session.currentPeerId;
        return sendActiveContext(
          session,
          'CONVERSATION',
          session.currentPeerId
        );
      case 'open_group_conversation':
        session.currentGroupId = input.context.currentGroupId ?? session.currentGroupId;
        return sendActiveContext(session, 'CONVERSATION', session.currentGroupId);
      case 'send_private_message':
        return sendPrivateMessage(input, session);
      case 'send_group_message':
        return sendGroupMessage(input, session);
      default:
        return noopRealtimeOutcome();
    }
  }
}
