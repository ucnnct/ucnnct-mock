import { ActionCounters, ObjectiveMix, SessionObjective, UserAction } from '../models.js';
import { ObjectiveBoostMap } from './runtime.js';

export function emptyActionCounters(): ActionCounters {
  return {
    login: 0,
    open_home: 0,
    fetch_notifications: 0,
    fetch_friends: 0,
    open_private_conversation: 0,
    send_private_message: 0,
    open_group_conversation: 0,
    send_group_message: 0,
    create_group: 0,
    add_member: 0,
    prepare_upload: 0,
    upload_file: 0,
    open_notifications: 0,
    accept_friend_request: 0,
    logout: 0
  };
}

export function emptyObjectiveMix(): ObjectiveMix {
  return {
    browse: 0,
    reply_messages: 0,
    socialize: 0,
    group_activity: 0,
    share_file: 0
  };
}

export function objectiveBoostMap(objective: SessionObjective | null): ObjectiveBoostMap {
  switch (objective) {
    case 'browse':
      return { browse: 1.75, privateMessage: 0.75, group: 0.7, media: 0.65, social: 0.9, notifications: 1.2 };
    case 'reply_messages':
      return { browse: 0.65, privateMessage: 1.85, group: 1.05, media: 0.8, social: 0.7, notifications: 1.25 };
    case 'socialize':
      return { browse: 0.85, privateMessage: 0.95, group: 1, media: 0.7, social: 1.8, notifications: 1 };
    case 'group_activity':
      return { browse: 0.7, privateMessage: 0.8, group: 1.95, media: 0.95, social: 0.9, notifications: 1.1 };
    case 'share_file':
      return {
        browse: 0.45,
        privateMessage: 1.15,
        group: 1.15,
        media: 3.1,
        social: 0.6,
        notifications: 0.7
      };
    default:
      return { browse: 1, privateMessage: 1, group: 1, media: 1, social: 1, notifications: 1 };
  }
}

export function requestCostForAction(action: UserAction): number {
  switch (action) {
    case 'login':
      return 4;
    case 'open_private_conversation':
    case 'open_group_conversation':
    case 'send_private_message':
    case 'send_group_message':
    case 'add_member':
    case 'accept_friend_request':
      return 2;
    case 'create_group':
    case 'prepare_upload':
    case 'upload_file':
      return 3;
    default:
      return 1;
  }
}

export function baseLatencyForAction(action: UserAction): number {
  switch (action) {
    case 'login':
      return 180;
    case 'send_private_message':
    case 'send_group_message':
      return 132;
    case 'prepare_upload':
      return 196;
    case 'upload_file':
      return 240;
    case 'create_group':
      return 162;
    default:
      return 92;
  }
}

export function errorChanceForAction(action: UserAction): number {
  switch (action) {
    case 'upload_file':
      return 0.03;
    case 'prepare_upload':
    case 'login':
      return 0.015;
    case 'send_private_message':
    case 'send_group_message':
      return 0.012;
    default:
      return 0.006;
  }
}
